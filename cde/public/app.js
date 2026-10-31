'use strict';
// Giao diện CDE – JavaScript thuần, định tuyến bằng hash: #/  #/p/<id>/<tab>

const $app = document.getElementById('app');
const $modal = document.getElementById('modal-root');
let ME = null;
let META = null;

// ------------------------------------------------------------------ Tiện ích
function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'value') el.value = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

async function api(method, url, body, opts = {}) {
  const init = { method, headers: {} };
  if (opts.raw) {
    init.body = body;
    Object.assign(init.headers, opts.headers);
  } else if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(url, init);
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && url !== '/api/login') {
    ME = null;
    render();
  }
  if (!res.ok) throw new Error(data.error || `Lỗi ${res.status}`);
  return data;
}

function toast(msg, isErr) {
  const el = h('div', { class: isErr ? 'err' : '' }, msg);
  document.getElementById('toast').append(el);
  setTimeout(() => el.remove(), isErr ? 6000 : 3000);
}

// Bọc thao tác bất đồng bộ: hiển thị lỗi, chặn nhấn lặp.
function action(fn) {
  return async (ev) => {
    if (ev && ev.preventDefault) ev.preventDefault();
    const btn = ev && ev.submitter ? ev.submitter : ev && ev.currentTarget instanceof HTMLButtonElement ? ev.currentTarget : null;
    if (btn) btn.disabled = true;
    try {
      await fn(ev);
    } catch (err) {
      toast(err.message, true);
    } finally {
      if (btn) btn.disabled = false;
    }
  };
}

const fmtDate = (s) => (s ? new Date(s).toLocaleString('vi-VN', { dateStyle: 'short', timeStyle: 'short' }) : '—');
const fmtSize = (n) => (n == null ? '—' : n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);
const stateBadge = (s) => h('span', { class: `badge st-${s}` }, META.stateLabels[s]);
const statusText = (state, code) => (META.statusCodes[state] || {})[code] || code;
const ISSUE_STATUS = { open: 'Mở', in_progress: 'Đang xử lý', resolved: 'Đã giải quyết', closed: 'Đã đóng' };
const PRIORITY = { low: 'Thấp', medium: 'Trung bình', high: 'Cao', critical: 'Khẩn cấp' };
const ISSUE_TYPES = { RFI: 'RFI – Yêu cầu thông tin', ISSUE: 'Vấn đề', CLASH: 'Va chạm', NCR: 'Không phù hợp (NCR)' };
const DECISION = { pending: 'Chờ duyệt', approved: 'Đã duyệt', rejected: 'Từ chối' };
const roleRank = { viewer: 0, member: 1, lead: 2, manager: 3 };
const atLeast = (role, min) => roleRank[role] >= roleRank[min];

function formData(form) {
  const out = {};
  for (const [k, v] of new FormData(form).entries()) {
    if (v instanceof File) continue;
    if (k in out) out[k] = [].concat(out[k], v);
    else out[k] = v;
  }
  return out;
}

function options(map, selected, empty) {
  const opts = Object.entries(map).map(([k, v]) => h('option', { value: k, selected: k === selected }, v));
  return empty !== undefined ? [h('option', { value: '' }, empty), ...opts] : opts;
}

function openModal(title, body, wide) {
  const close = () => {
    $modal.innerHTML = '';
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (e) => e.key === 'Escape' && close();
  document.addEventListener('keydown', onKey);
  const backdrop = h('div', { class: 'modal-backdrop', onmousedown: (e) => e.target === backdrop && close() },
    h('div', { class: `modal${wide ? ' wide' : ''}` },
      h('div', { class: 'modal-head' }, typeof title === 'string' ? h('h2', {}, title) : title, h('button', { class: 'x', onclick: close, title: 'Đóng' }, '×')),
      body));
  $modal.innerHTML = '';
  $modal.append(backdrop);
  const first = backdrop.querySelector('input, select, textarea');
  if (first) first.focus();
  return close;
}

// ------------------------------------------------------------------ Khởi động & định tuyến
async function boot() {
  try {
    ME = await api('GET', '/api/me');
    META = await api('GET', '/api/meta');
  } catch {
    ME = null;
  }
  render();
}

window.addEventListener('hashchange', () => render());

function renderUserbox() {
  const box = document.getElementById('userbox');
  box.innerHTML = '';
  if (!ME) return;
  box.append(
    h('span', {}, `${ME.name} · ${ME.org}${ME.isAdmin ? ' · Quản trị' : ''}`),
    h('button', { onclick: changePasswordDialog }, 'Đổi mật khẩu'),
    h('button', { onclick: action(async () => { await api('POST', '/api/logout'); ME = null; location.hash = '#/'; render(); }) }, 'Đăng xuất'),
  );
}

async function render() {
  renderUserbox();
  $modal.innerHTML = '';
  if (!ME) return renderLogin();
  const parts = location.hash.replace(/^#\/?/, '').split('/');
  try {
    if (parts[0] === 'p' && parts[1]) await renderProject(parts[1], parts[2] || 'overview');
    else await renderProjects();
  } catch (err) {
    $app.innerHTML = '';
    $app.append(h('div', { class: 'panel' }, h('p', {}, err.message), h('a', { href: '#/' }, '← Về danh sách dự án')));
  }
}

function renderLogin() {
  $app.innerHTML = '';
  $app.append(h('div', { class: 'panel login' },
    h('h1', {}, 'Đăng nhập CDE'),
    h('p', { class: 'muted' }, 'Môi trường dữ liệu chung quản lý thông tin dự án theo ISO 19650.'),
    h('form', {
      onsubmit: action(async (e) => {
        ME = await api('POST', '/api/login', formData(e.target));
        META = await api('GET', '/api/meta');
        render();
      }),
    },
    h('label', {}, 'Tên đăng nhập', h('input', { name: 'username', autocomplete: 'username', required: true })),
    h('label', {}, 'Mật khẩu', h('input', { name: 'password', type: 'password', autocomplete: 'current-password', required: true })),
    h('button', { class: 'primary', type: 'submit' }, 'Đăng nhập'))));
}

function changePasswordDialog() {
  const close = openModal('Đổi mật khẩu', h('form', {
    onsubmit: action(async (e) => {
      await api('POST', '/api/me/password', formData(e.target));
      close();
      toast('Đã đổi mật khẩu');
    }),
  },
  h('label', {}, 'Mật khẩu hiện tại', h('input', { name: 'oldPassword', type: 'password', required: true })),
  h('label', {}, 'Mật khẩu mới (≥ 6 ký tự)', h('input', { name: 'newPassword', type: 'password', minlength: 6, required: true })),
  h('button', { class: 'primary', type: 'submit' }, 'Lưu')));
}

// ------------------------------------------------------------------ Danh sách dự án
async function renderProjects() {
  const projects = await api('GET', '/api/projects');
  $app.innerHTML = '';
  $app.append(h('div', { class: 'row', style: 'margin-bottom:16px' },
    h('h1', {}, 'Dự án của bạn'), h('span', { class: 'spacer' }),
    ME.isAdmin && h('button', { onclick: createUserDialog }, '+ Người dùng'),
    ME.isAdmin && h('button', { class: 'primary', onclick: createProjectDialog }, '+ Dự án mới')));
  if (!projects.length) {
    $app.append(h('div', { class: 'panel empty' }, ME.isAdmin ? 'Chưa có dự án. Hãy tạo dự án đầu tiên.' : 'Bạn chưa được thêm vào dự án nào.'));
    return;
  }
  $app.append(h('div', { class: 'grid' }, projects.map((p) =>
    h('a', { class: 'panel card-link', href: `#/p/${p.id}` },
      h('div', { class: 'row' }, h('span', { class: 'badge st-SHARED mono' }, p.code), h('span', { class: 'muted small' }, META.projectRoles[p.myRole])),
      h('h3', { style: 'margin-top:8px' }, p.name),
      h('div', { class: 'muted small' }, [p.client, p.location, p.stage].filter(Boolean).join(' · ') || '—'),
      h('div', { class: 'row small', style: 'margin-top:10px' },
        h('span', {}, `${p.containerCount} container`), h('span', {}, `${p.memberCount} thành viên`), h('span', {}, `${p.openIssues} vấn đề mở`))))));
}

function createProjectDialog() {
  const close = openModal('Tạo dự án', h('form', {
    onsubmit: action(async (e) => {
      const p = await api('POST', '/api/projects', formData(e.target));
      close();
      location.hash = `#/p/${p.id}`;
    }),
  },
  h('div', { class: 'form-grid' },
    h('label', {}, 'Mã dự án (2–6 ký tự)', h('input', { name: 'code', required: true, maxlength: 6, style: 'text-transform:uppercase' })),
    h('label', { style: 'grid-column: span 2' }, 'Tên dự án', h('input', { name: 'name', required: true }))),
  h('div', { class: 'form-grid' },
    h('label', {}, 'Chủ đầu tư', h('input', { name: 'client' })),
    h('label', {}, 'Địa điểm', h('input', { name: 'location' })),
    h('label', {}, 'Giai đoạn', h('input', { name: 'stage', placeholder: 'vd. Thiết kế cơ sở' }))),
  h('label', {}, 'Mô tả', h('textarea', { name: 'description' })),
  h('button', { class: 'primary', type: 'submit' }, 'Tạo dự án')));
}

function createUserDialog() {
  const close = openModal('Tạo người dùng', h('form', {
    onsubmit: action(async (e) => {
      const d = formData(e.target);
      d.isAdmin = d.isAdmin === 'on';
      const u = await api('POST', '/api/users', d);
      close();
      toast(`Đã tạo ${u.username}`);
    }),
  },
  h('div', { class: 'form-grid' },
    h('label', {}, 'Tên đăng nhập', h('input', { name: 'username', required: true })),
    h('label', {}, 'Họ tên', h('input', { name: 'name', required: true })),
    h('label', {}, 'Email', h('input', { name: 'email', type: 'email' })),
    h('label', {}, 'Mã đơn vị (3–6 ký tự)', h('input', { name: 'org', required: true, maxlength: 6, style: 'text-transform:uppercase', title: 'Dùng làm mã "Đơn vị tạo lập" trong tên container' })),
    h('label', {}, 'Mật khẩu (≥ 6 ký tự)', h('input', { name: 'password', type: 'password', minlength: 6, required: true }))),
  h('label', { class: 'row' }, h('input', { name: 'isAdmin', type: 'checkbox', style: 'width:auto' }), 'Quản trị hệ thống'),
  h('button', { class: 'primary', type: 'submit' }, 'Tạo')));
}

// ------------------------------------------------------------------ Không gian dự án
const TABS = [
  ['overview', 'Tổng quan'],
  ['documents', 'Container thông tin'],
  ['approvals', 'Phê duyệt'],
  ['issues', 'Vấn đề / RFI'],
  ['transmittals', 'Chuyển giao'],
  ['members', 'Thành viên'],
  ['activity', 'Nhật ký'],
];

let PROJECT = null;

async function renderProject(pid, tab) {
  PROJECT = await api('GET', `/api/projects/${pid}`);
  const dash = await api('GET', `/api/projects/${pid}/dashboard`);
  const view = h('div');
  $app.innerHTML = '';
  $app.append(
    h('div', { class: 'row', style: 'margin-bottom:6px' },
      h('a', { href: '#/' }, '← Dự án'),
      h('span', { class: 'badge st-SHARED mono' }, PROJECT.code),
      h('h1', { style: 'margin:0' }, PROJECT.name),
      h('span', { class: 'spacer' }),
      h('span', { class: 'muted' }, `Vai trò: ${META.projectRoles[PROJECT.myRole]}`)),
    h('div', { class: 'muted small', style: 'margin-bottom:12px' }, [PROJECT.client, PROJECT.location, PROJECT.stage].filter(Boolean).join(' · ')),
    h('nav', { class: 'tabs' }, TABS.map(([k, label]) =>
      h('a', { href: `#/p/${pid}/${k}`, class: k === tab ? 'active' : '' }, label,
        k === 'approvals' && dash.myApprovals ? h('span', { class: 'count' }, dash.myApprovals) : null))),
    view);
  const renderers = { overview: viewOverview, documents: viewDocuments, approvals: viewApprovals, issues: viewIssues, transmittals: viewTransmittals, members: viewMembers, activity: viewActivity };
  await (renderers[tab] || viewOverview)(view, dash);
}

const reload = () => render();

// --- Tổng quan
async function viewOverview(view, dash) {
  const total = Object.values(dash.byRole).reduce((a, b) => a + b, 0) || 1;
  view.append(
    h('div', { class: 'stats' },
      stat(dash.pendingApprovals, 'Yêu cầu chờ phê duyệt'),
      stat(dash.myApprovals, 'Chờ bạn phê duyệt'),
      stat(dash.myIssues, 'Vấn đề giao cho bạn'),
      stat(dash.overdueIssues, 'Vấn đề quá hạn'),
      stat(dash.transmittals, 'Phiếu chuyển giao')),
    h('div', { class: 'panel' },
      h('h2', {}, 'Luồng thông tin CDE'),
      h('div', { class: 'flow' }, META.states.map((s) =>
        h('div', { class: `node ${s}` }, h('a', { href: `#/p/${PROJECT.id}/documents`, onclick: () => (DOC_FILTER.state = s) }, h('b', {}, dash.byState[s]), META.stateLabels[s])))),
      h('p', { class: 'muted small', style: 'margin:10px 0 0' },
        'WIP → (Trưởng nhóm kiểm tra) → Shared → (Quản lý thông tin phê duyệt) → Published → Archived. ',
        'Container WIP chỉ hiển thị với đơn vị tạo lập.')),
    h('div', { class: 'grid', style: 'grid-template-columns: repeat(auto-fit, minmax(320px, 1fr))' },
      h('div', { class: 'panel' }, h('h2', {}, 'Container theo bộ môn'),
        Object.keys(dash.byRole).length
          ? h('div', { class: 'bars' }, Object.entries(dash.byRole).sort((a, b) => b[1] - a[1]).map(([r, n]) =>
            h('div', { class: 'bar' }, h('span', {}, `${r} – ${META.roleCodes[r] || ''}`), h('div', { class: 'track' }, h('div', { class: 'fill', style: `width:${(n / total) * 100}%` })), h('b', {}, n))))
          : h('div', { class: 'empty' }, 'Chưa có container')),
      h('div', { class: 'panel' }, h('h2', {}, 'Hoạt động gần đây'), activityFeed(dash.recent))));
}

const stat = (v, l) => h('div', { class: 'stat' }, h('div', { class: 'v' }, v), h('div', { class: 'l' }, l));

function activityFeed(items) {
  if (!items.length) return h('div', { class: 'empty' }, 'Chưa có hoạt động');
  return h('ul', { class: 'feed' }, items.map((a) =>
    h('li', {}, h('div', {}, a.detail), h('div', { class: 'muted small' }, `${a.userName} · ${fmtDate(a.at)}`))));
}

// --- Container thông tin
const DOC_FILTER = { state: '', q: '' };

async function viewDocuments(view) {
  const list = h('div', { class: 'panel table-wrap' });
  const load = async () => {
    const qs = new URLSearchParams();
    if (DOC_FILTER.state) qs.set('state', DOC_FILTER.state);
    if (DOC_FILTER.q) qs.set('q', DOC_FILTER.q);
    const items = await api('GET', `/api/projects/${PROJECT.id}/containers?${qs}`);
    list.innerHTML = '';
    if (!items.length) return list.append(h('div', { class: 'empty' }, 'Không có container nào'));
    list.append(h('table', {},
      h('thead', {}, h('tr', {}, ['Tên container', 'Tiêu đề', 'Trạng thái', 'Tình trạng', 'Rev', 'Tệp', 'Cập nhật'].map((t) => h('th', {}, t)))),
      h('tbody', {}, items.map((c) => h('tr', { class: 'click', onclick: () => containerDialog(c.id, load) },
        h('td', { class: 'mono' }, c.name),
        h('td', {}, c.title, c.pending ? h('div', { class: 'small', style: 'color:var(--wip)' }, `⏳ Chờ duyệt → ${c.pending.to}`) : null),
        h('td', {}, stateBadge(c.state)),
        h('td', { title: statusText(c.state, c.statusCode) }, h('b', { class: 'mono' }, c.statusCode)),
        h('td', { class: 'mono' }, c.revision || '—'),
        h('td', { class: 'small' }, c.fileName ? `${c.fileName} (${fmtSize(c.size)})` : h('span', { class: 'muted' }, 'chưa có tệp')),
        h('td', { class: 'small muted' }, fmtDate(c.updatedAt)))))));
  };
  const chips = h('div', { class: 'chips' }, [['', 'Tất cả'], ...META.states.map((s) => [s, META.stateLabels[s]])].map(([s, label]) =>
    h('button', {
      class: `chip${DOC_FILTER.state === s ? ' active' : ''}`,
      onclick: action(async (e) => {
        DOC_FILTER.state = s;
        chips.querySelectorAll('.chip').forEach((b) => b.classList.remove('active'));
        e.currentTarget.classList.add('active');
        await load();
      }),
    }, label)));
  let timer;
  view.append(
    h('div', { class: 'row', style: 'margin-bottom:12px' }, chips, h('span', { class: 'spacer' }),
      h('input', { placeholder: 'Tìm theo tên, tiêu đề…', value: DOC_FILTER.q, style: 'max-width:240px', oninput: (e) => { DOC_FILTER.q = e.target.value; clearTimeout(timer); timer = setTimeout(load, 250); } }),
      atLeast(PROJECT.myRole, 'member') && h('button', { class: 'primary', onclick: () => createContainerDialog(load) }, '+ Container')),
    list);
  await load();
}

function createContainerDialog(onDone) {
  const isManager = PROJECT.myRole === 'manager';
  const preview = h('div', { class: 'name-preview' });
  const f = (name, el) => h('label', { title: META.fieldRules[name].hint }, `${META.fieldRules[name].label}`, el);
  const form = h('form', {
    onsubmit: action(async (e) => {
      const d = formData(e.target);
      const fields = Object.fromEntries(META.fieldOrder.filter((k) => k !== 'project').map((k) => [k, d[k]]));
      await api('POST', `/api/projects/${PROJECT.id}/containers`, { fields, title: d.title, description: d.description });
      close();
      toast('Đã tạo container');
      onDone();
    }),
    oninput: () => update(),
  },
  preview,
  h('div', { class: 'form-grid' },
    f('originator', h('input', { name: 'originator', value: ME.org, readonly: !isManager && !ME.isAdmin, maxlength: 6, style: 'text-transform:uppercase' })),
    f('volume', h('input', { name: 'volume', value: 'ZZ', maxlength: 2, style: 'text-transform:uppercase' })),
    f('level', h('input', { name: 'level', value: 'ZZ', maxlength: 2, style: 'text-transform:uppercase' })),
    f('type', h('select', { name: 'type' }, options(Object.fromEntries(Object.entries(META.typeCodes).map(([k, v]) => [k, `${k} – ${v}`])), 'DR'))),
    f('role', h('select', { name: 'role' }, options(Object.fromEntries(Object.entries(META.roleCodes).map(([k, v]) => [k, `${k} – ${v}`])), 'A'))),
    h('label', {}, 'Số hiệu', h('div', { class: 'row', style: 'flex-wrap:nowrap;margin-top:3px' },
      h('input', { name: 'number', value: '0001', maxlength: 6, required: true }),
      h('button', { type: 'button', title: 'Lấy số tiếp theo', onclick: action(suggest) }, '↻')))),
  h('label', {}, 'Tiêu đề', h('input', { name: 'title', required: true })),
  h('label', {}, 'Mô tả', h('textarea', { name: 'description' })),
  h('p', { class: 'muted small' }, 'Quy ước tên: Dự án-Đơn vị-Khối-Tầng-Loại-Bộ môn-Số hiệu. Container mới ở trạng thái WIP (S0).'),
  h('button', { class: 'primary', type: 'submit' }, 'Tạo container'));
  const val = (n) => (form.elements[n].value || '').toUpperCase();
  function update() {
    preview.textContent = [PROJECT.code, ...META.fieldOrder.slice(1).map(val)].join('-');
  }
  async function suggest() {
    const qs = new URLSearchParams(Object.fromEntries(['originator', 'volume', 'level', 'type', 'role'].map((k) => [k, val(k)])));
    form.elements.number.value = (await api('GET', `/api/projects/${PROJECT.id}/next-number?${qs}`)).number;
    update();
  }
  const close = openModal('Tạo container thông tin', form);
  suggest().catch(() => {});
  update();
}

async function containerDialog(cid, onChange) {
  const c = await api('GET', `/api/containers/${cid}`);
  const refresh = async () => {
    await containerDialog(cid, onChange);
    if (onChange) onChange();
  };
  const actions = [];
  const canManage = PROJECT.myRole === 'manager';
  if (c.pending) {
    actions.push(h('div', { class: 'notice', style: 'margin:0;flex:1' }, `⏳ Đang chờ phê duyệt chuyển sang ${META.stateLabels[c.pending.to]} (${c.pending.statusCode}).`));
  } else {
    if (c.state === 'WIP' && c.canEdit) {
      actions.push(h('button', { class: 'primary', onclick: () => uploadDialog(c, refresh) }, '⬆ Tải lên phiên bản'));
      actions.push(h('button', { onclick: () => editContainerDialog(c, refresh) }, 'Sửa thông tin'));
      if (c.versions.length && c.versions[0].state === 'WIP')
        actions.push(h('button', { onclick: () => transitionDialog(c, 'SHARED', refresh) }, 'Gửi kiểm tra → Shared'));
    }
    if (c.state === 'SHARED' && c.canEdit) {
      actions.push(h('button', { class: 'primary', onclick: () => transitionDialog(c, 'PUBLISHED', refresh) }, 'Đề nghị phát hành → Published'));
      actions.push(h('button', { onclick: () => transitionDialog(c, 'WIP', refresh) }, 'Thu hồi về WIP'));
    }
    if (c.state === 'PUBLISHED' && c.canEdit) actions.push(h('button', { onclick: () => transitionDialog(c, 'WIP', refresh) }, 'Tạo sửa đổi mới (về WIP)'));
    if ((c.state === 'SHARED' || c.state === 'PUBLISHED') && canManage) actions.push(h('button', { class: 'danger', onclick: () => transitionDialog(c, 'ARCHIVED', refresh) }, 'Lưu trữ'));
    if (atLeast(PROJECT.myRole, 'member')) actions.push(h('button', { onclick: () => createIssueDialog(refresh, [c.id]) }, '+ Vấn đề / RFI'));
  }

  const body = h('div', {},
    h('dl', { class: 'kv' },
      h('dt', {}, 'Tiêu đề'), h('dd', {}, c.title),
      c.description && [h('dt', {}, 'Mô tả'), h('dd', {}, c.description)],
      h('dt', {}, 'Trạng thái'), h('dd', {}, stateBadge(c.state), ' ', h('b', { class: 'mono' }, c.statusCode), ' – ', statusText(c.state, c.statusCode)),
      h('dt', {}, 'Sửa đổi hiện tại'), h('dd', { class: 'mono' }, c.revision || '—'),
      h('dt', {}, 'Mã hóa'), h('dd', {}, META.fieldOrder.map((k) => h('span', { class: 'badge st-ARCHIVED', style: 'margin:0 4px 4px 0', title: META.fieldRules[k].label }, `${META.fieldRules[k].label}: ${c.fields[k]}`))),
      h('dt', {}, 'Loại / Bộ môn'), h('dd', {}, `${META.typeCodes[c.fields.type] || c.fields.type} · ${META.roleCodes[c.fields.role] || c.fields.role}`),
      h('dt', {}, 'Người tạo'), h('dd', {}, `${c.createdBy} · ${fmtDate(c.createdAt)}`)),
    actions.length ? h('div', { class: 'actions' }, actions) : null,
    h('h3', {}, 'Lịch sử phiên bản'),
    c.versions.length
      ? h('div', { class: 'table-wrap' }, h('table', {},
        h('thead', {}, h('tr', {}, ['Rev', 'Trạng thái', 'Tệp', 'Người thực hiện', 'Thời gian', 'Ghi chú', ''].map((t) => h('th', {}, t)))),
        h('tbody', {}, c.versions.map((v) => h('tr', {},
          h('td', { class: 'mono' }, h('b', {}, v.revision)),
          h('td', {}, stateBadge(v.state), ' ', h('span', { class: 'mono small' }, v.statusCode)),
          h('td', { class: 'small' }, v.fileName, h('div', { class: 'muted mono', title: `SHA-256: ${v.sha256}` }, `${fmtSize(v.size)} · ${v.sha256.slice(0, 10)}…`)),
          h('td', { class: 'small' }, v.by),
          h('td', { class: 'small muted' }, fmtDate(v.at)),
          h('td', { class: 'small' }, v.note || ''),
          h('td', {}, h('a', { href: `/api/versions/${v.id}/download` }, 'Tải về')))))))
      : h('div', { class: 'empty' }, 'Chưa có tệp – hãy tải lên phiên bản đầu tiên.'),
    c.workflows.length ? [h('h3', { style: 'margin-top:16px' }, 'Lịch sử phê duyệt'), workflowTable(c.workflows, refresh, false)] : null,
    c.issues.length ? [h('h3', { style: 'margin-top:16px' }, 'Vấn đề liên quan'),
      h('ul', {}, c.issues.map((i) => h('li', {}, h('a', { href: '#', onclick: (e) => { e.preventDefault(); issueDialog(i.id, refresh); } }, i.ref), ` ${i.title} `, h('span', { class: `badge is-${i.status}` }, ISSUE_STATUS[i.status]))))] : null);

  openModal(h('div', {}, h('div', { class: 'mono', style: 'font-size:17px;font-weight:700' }, c.name), h('div', { class: 'muted' }, c.title)), body, true);
}

function uploadDialog(c, onDone) {
  const progress = h('div', { class: 'muted small' });
  const close = openModal(`Tải lên phiên bản – ${c.name}`, h('form', {
    onsubmit: action(async (e) => {
      const file = e.target.elements.file.files[0];
      if (!file) throw new Error('Chọn tệp để tải lên');
      if (file.size > META.maxUploadMb * 1048576) throw new Error(`Tệp vượt quá ${META.maxUploadMb} MB`);
      progress.textContent = 'Đang tải lên…';
      const note = e.target.elements.note.value;
      await api('PUT', `/api/containers/${c.id}/versions?note=${encodeURIComponent(note)}`, file, {
        raw: true,
        headers: { 'X-File-Name': encodeURIComponent(file.name), 'Content-Type': file.type || 'application/octet-stream' },
      });
      close();
      toast('Đã tải lên phiên bản mới');
      onDone();
    }),
  },
  h('label', {}, `Tệp (tối đa ${META.maxUploadMb} MB) – IFC, RVT, DWG, PDF, …`, h('input', { name: 'file', type: 'file', required: true })),
  h('label', {}, 'Ghi chú thay đổi', h('textarea', { name: 'note', placeholder: 'Mô tả nội dung thay đổi' })),
  progress,
  h('button', { class: 'primary', type: 'submit' }, 'Tải lên')));
}

function editContainerDialog(c, onDone) {
  const close = openModal('Sửa thông tin container', h('form', {
    onsubmit: action(async (e) => {
      await api('PATCH', `/api/containers/${c.id}`, formData(e.target));
      close();
      onDone();
    }),
  },
  h('label', {}, 'Tiêu đề', h('input', { name: 'title', value: c.title, required: true })),
  h('label', {}, 'Mô tả', h('textarea', { name: 'description' }, c.description)),
  h('button', { class: 'primary', type: 'submit' }, 'Lưu')));
}

function transitionDialog(c, to, onDone) {
  const t = META.transitions[`${c.state}>${to}`];
  const codes = META.statusCodes[to];
  const needsCode = to === 'SHARED' || to === 'PUBLISHED';
  const close = openModal(`${t.label}: ${c.name}`, h('form', {
    onsubmit: action(async (e) => {
      const r = await api('POST', `/api/containers/${c.id}/transition`, { to, ...formData(e.target) });
      close();
      toast(r.done ? 'Đã chuyển trạng thái' : 'Đã gửi yêu cầu phê duyệt');
      onDone();
    }),
  },
  h('p', {}, stateBadge(c.state), ' → ', stateBadge(to)),
  !t.direct && h('p', { class: 'muted small' }, `Yêu cầu sẽ được gửi tới người có vai trò "${META.projectRoles[t.approverRole]}" trở lên để phê duyệt.`),
  needsCode && h('label', {}, 'Mã tình trạng (suitability)', h('select', { name: 'statusCode' }, options(Object.fromEntries(Object.entries(codes).map(([k, v]) => [k, `${k} – ${v}`]))))),
  h('label', {}, 'Ghi chú', h('textarea', { name: 'comment' })),
  h('button', { class: 'primary', type: 'submit' }, t.direct ? 'Xác nhận' : 'Gửi yêu cầu')));
}

// --- Phê duyệt
function workflowTable(items, onDone, showContainer = true) {
  return h('div', { class: 'table-wrap' }, h('table', {},
    h('thead', {}, h('tr', {}, [showContainer && 'Container', 'Yêu cầu', 'Rev', 'Người gửi', 'Kết quả', ''].filter(Boolean).map((t) => h('th', {}, t)))),
    h('tbody', {}, items.map((w) => h('tr', {},
      showContainer && h('td', {}, h('a', { href: '#', class: 'mono', onclick: (e) => { e.preventDefault(); containerDialog(w.containerId, onDone); } }, w.containerName), h('div', { class: 'small muted' }, w.containerTitle)),
      h('td', {}, h('div', {}, w.label), h('div', { class: 'small' }, stateBadge(w.from), ' → ', stateBadge(w.to), ' ', h('b', { class: 'mono' }, w.statusCode)), w.comment && h('div', { class: 'small muted' }, `“${w.comment}”`)),
      h('td', { class: 'mono' }, w.revision),
      h('td', { class: 'small' }, w.requestedByName, h('div', { class: 'muted' }, fmtDate(w.requestedAt))),
      h('td', { class: 'small' }, h('span', { class: `badge dec-${w.decision}` }, DECISION[w.decision]),
        w.decidedByName && h('div', { class: 'muted' }, `${w.decidedByName} · ${fmtDate(w.decidedAt)}`),
        w.decisionComment && h('div', {}, `“${w.decisionComment}”`)),
      h('td', {}, w.canDecide && h('div', { class: 'row' },
        h('button', { class: 'ok', onclick: () => decisionDialog(w, true, onDone) }, '✓ Duyệt'),
        h('button', { class: 'danger', onclick: () => decisionDialog(w, false, onDone) }, '✕ Từ chối'))))))));
}

function decisionDialog(w, approve, onDone) {
  const close = openModal(`${approve ? 'Phê duyệt' : 'Từ chối'}: ${w.containerName}`, h('form', {
    onsubmit: action(async (e) => {
      await api('POST', `/api/workflows/${w.id}/decision`, { approve, comment: e.target.elements.comment.value });
      close();
      toast(approve ? 'Đã phê duyệt' : 'Đã từ chối');
      onDone();
    }),
  },
  h('p', {}, `${w.label} – ${w.revision} – ${w.statusCode}`),
  h('label', {}, approve ? 'Ý kiến (không bắt buộc)' : 'Lý do từ chối', h('textarea', { name: 'comment', required: !approve })),
  h('button', { class: approve ? 'primary' : 'danger', type: 'submit' }, approve ? 'Phê duyệt' : 'Từ chối')));
}

async function viewApprovals(view) {
  const [pending, all] = await Promise.all([
    api('GET', `/api/projects/${PROJECT.id}/workflows?status=pending`),
    api('GET', `/api/projects/${PROJECT.id}/workflows`),
  ]);
  const done = all.filter((w) => w.decision !== 'pending');
  view.append(
    h('div', { class: 'panel' }, h('h2', {}, `Đang chờ phê duyệt (${pending.length})`),
      pending.length ? workflowTable(pending, reload) : h('div', { class: 'empty' }, 'Không có yêu cầu nào đang chờ')),
    h('div', { class: 'panel' }, h('h2', {}, 'Đã xử lý'),
      done.length ? workflowTable(done, reload) : h('div', { class: 'empty' }, 'Chưa có')));
}

// --- Vấn đề / RFI
const ISSUE_FILTER = { status: 'active' };

async function viewIssues(view) {
  const issues = await api('GET', `/api/projects/${PROJECT.id}/issues`);
  const shown = issues.filter((i) => ISSUE_FILTER.status === 'all' || (ISSUE_FILTER.status === 'active' ? !['resolved', 'closed'].includes(i.status) : i.status === ISSUE_FILTER.status));
  const today = new Date().toISOString().slice(0, 10);
  view.append(
    h('div', { class: 'row', style: 'margin-bottom:12px' },
      h('div', { class: 'chips' }, [['active', 'Đang mở'], ['all', 'Tất cả'], ...Object.entries(ISSUE_STATUS)].map(([k, label]) =>
        h('button', { class: `chip${ISSUE_FILTER.status === k ? ' active' : ''}`, onclick: () => { ISSUE_FILTER.status = k; reload(); } }, label))),
      h('span', { class: 'spacer' }),
      atLeast(PROJECT.myRole, 'member') && h('button', { class: 'primary', onclick: () => createIssueDialog(reload) }, '+ Vấn đề / RFI')),
    h('div', { class: 'panel table-wrap' }, shown.length
      ? h('table', {},
        h('thead', {}, h('tr', {}, ['Mã', 'Tiêu đề', 'Ưu tiên', 'Trạng thái', 'Giao cho', 'Hạn', 'Cập nhật'].map((t) => h('th', {}, t)))),
        h('tbody', {}, shown.map((i) => h('tr', { class: 'click', onclick: () => issueDialog(i.id, reload) },
          h('td', { class: 'mono' }, i.ref),
          h('td', {}, i.title, i.containers.length ? h('div', { class: 'small muted mono' }, i.containers.map((c) => c.name).join(', ')) : null),
          h('td', { class: `pr-${i.priority}` }, PRIORITY[i.priority]),
          h('td', {}, h('span', { class: `badge is-${i.status}` }, ISSUE_STATUS[i.status])),
          h('td', { class: 'small' }, i.assigneeName || '—'),
          h('td', { class: 'small', style: i.dueDate && i.dueDate < today && !['resolved', 'closed'].includes(i.status) ? 'color:var(--danger);font-weight:600' : '' }, i.dueDate || '—'),
          h('td', { class: 'small muted' }, fmtDate(i.updatedAt))))))
      : h('div', { class: 'empty' }, 'Không có vấn đề nào')));
}

const memberOptions = (selected) => [h('option', { value: '' }, '— Chưa giao —'), ...PROJECT.members.map((m) => h('option', { value: m.id, selected: m.id === selected }, `${m.name} (${m.org})`))];

async function createIssueDialog(onDone, containerIds = []) {
  const containers = await api('GET', `/api/projects/${PROJECT.id}/containers`);
  const close = openModal('Tạo vấn đề / RFI', h('form', {
    onsubmit: action(async (e) => {
      const d = formData(e.target);
      d.containerIds = [].concat(d.containerIds || []);
      const i = await api('POST', `/api/projects/${PROJECT.id}/issues`, d);
      close();
      toast(`Đã tạo ${i.ref}`);
      onDone();
    }),
  },
  h('div', { class: 'form-grid' },
    h('label', {}, 'Loại', h('select', { name: 'type' }, options(ISSUE_TYPES, 'RFI'))),
    h('label', {}, 'Ưu tiên', h('select', { name: 'priority' }, options(PRIORITY, 'medium'))),
    h('label', {}, 'Giao cho', h('select', { name: 'assigneeId' }, memberOptions())),
    h('label', {}, 'Hạn xử lý', h('input', { name: 'dueDate', type: 'date' }))),
  h('label', {}, 'Tiêu đề', h('input', { name: 'title', required: true })),
  h('label', {}, 'Mô tả', h('textarea', { name: 'description' })),
  containers.length ? [h('label', {}, 'Container liên quan'), h('div', { class: 'checklist' }, containers.map((c) =>
    h('label', {}, h('input', { type: 'checkbox', name: 'containerIds', value: c.id, checked: containerIds.includes(c.id) }), h('span', { class: 'mono' }, c.name), h('span', { class: 'muted' }, c.title))))] : null,
  h('button', { class: 'primary', type: 'submit' }, 'Tạo')));
}

async function issueDialog(iid, onDone) {
  const issues = await api('GET', `/api/projects/${PROJECT.id}/issues`);
  const i = issues.find((x) => x.id === iid);
  if (!i) return toast('Không tìm thấy vấn đề', true);
  const canEdit = atLeast(PROJECT.myRole, 'member');
  const refresh = async () => {
    await issueDialog(iid, onDone);
    if (onDone) onDone();
  };
  const patch = (changes) => action(async () => {
    await api('PATCH', `/api/issues/${i.id}`, changes);
    await refresh();
  });
  openModal(h('div', {}, h('div', { class: 'mono muted' }, `${i.ref} · ${ISSUE_TYPES[i.type]}`), h('h2', { style: 'margin:4px 0 0' }, i.title)), h('div', {},
    h('dl', { class: 'kv' },
      h('dt', {}, 'Người tạo'), h('dd', {}, `${i.createdByName} · ${fmtDate(i.createdAt)}`),
      h('dt', {}, 'Trạng thái'), h('dd', {}, canEdit
        ? h('select', { style: 'max-width:220px', onchange: (e) => patch({ status: e.target.value })() }, options(ISSUE_STATUS, i.status))
        : h('span', { class: `badge is-${i.status}` }, ISSUE_STATUS[i.status])),
      h('dt', {}, 'Ưu tiên'), h('dd', {}, canEdit
        ? h('select', { style: 'max-width:220px', onchange: (e) => patch({ priority: e.target.value })() }, options(PRIORITY, i.priority))
        : PRIORITY[i.priority]),
      h('dt', {}, 'Giao cho'), h('dd', {}, canEdit
        ? h('select', { style: 'max-width:280px', onchange: (e) => patch({ assigneeId: e.target.value || null })() }, memberOptions(i.assigneeId))
        : i.assigneeName || '—'),
      h('dt', {}, 'Hạn xử lý'), h('dd', {}, canEdit
        ? h('input', { type: 'date', value: i.dueDate || '', style: 'max-width:180px', onchange: (e) => patch({ dueDate: e.target.value })() })
        : i.dueDate || '—'),
      i.containers.length && [h('dt', {}, 'Container'), h('dd', {}, i.containers.map((c) =>
        h('div', {}, h('a', { href: '#', class: 'mono', onclick: (e) => { e.preventDefault(); containerDialog(c.id); } }, c.name), ` ${c.title}`)))]),
    i.description && h('div', { class: 'panel', style: 'white-space:pre-wrap' }, i.description),
    h('h3', {}, 'Trao đổi'),
    i.comments.length ? i.comments.map((cm) => h('div', { class: `comment${cm.system ? ' system' : ''}` },
      h('div', { class: 'small muted' }, `${cm.userName} · ${fmtDate(cm.at)}`), h('div', { style: 'white-space:pre-wrap' }, cm.text))) : h('p', { class: 'muted' }, 'Chưa có trao đổi'),
    h('form', {
      onsubmit: action(async (e) => {
        await api('POST', `/api/issues/${i.id}/comments`, { text: e.target.elements.text.value });
        await refresh();
      }),
    }, h('textarea', { name: 'text', placeholder: 'Viết phản hồi…', required: true }), h('button', { class: 'primary', type: 'submit', style: 'margin-top:8px' }, 'Gửi'))), true);
}

// --- Chuyển giao (Transmittal)
async function viewTransmittals(view) {
  const items = await api('GET', `/api/projects/${PROJECT.id}/transmittals`);
  view.append(
    h('div', { class: 'row', style: 'margin-bottom:12px' },
      h('p', { class: 'muted', style: 'margin:0' }, 'Phiếu chuyển giao ghi nhận việc gửi thông tin đã chia sẻ/phát hành cho các bên, kèm sửa đổi & mã tình trạng tại thời điểm gửi.'),
      h('span', { class: 'spacer' }),
      atLeast(PROJECT.myRole, 'member') && h('button', { class: 'primary', onclick: createTransmittalDialog }, '+ Phiếu chuyển giao')),
    items.length ? items.map((t) => h('div', { class: 'panel' },
      h('div', { class: 'row' },
        h('b', { class: 'mono' }, t.ref), h('h3', { style: 'margin:0' }, t.subject), h('span', { class: 'badge st-SHARED' }, t.purpose),
        h('span', { class: 'spacer' }),
        t.mustAcknowledge && h('button', { class: 'primary', onclick: action(async () => { await api('POST', `/api/transmittals/${t.id}/acknowledge`); toast('Đã xác nhận'); reload(); }) }, 'Xác nhận đã nhận')),
      h('div', { class: 'small muted', style: 'margin:6px 0' }, `Từ ${t.fromName} · ${fmtDate(t.createdAt)}`),
      h('div', { class: 'small', style: 'margin-bottom:8px' }, 'Gửi tới: ', t.recipients.map((r, idx) => [idx ? ', ' : '', r.name, r.acknowledgedAt ? ' ✓' : ' (chưa xác nhận)'])),
      t.message && h('p', { style: 'white-space:pre-wrap' }, t.message),
      h('div', { class: 'table-wrap' }, h('table', {},
        h('thead', {}, h('tr', {}, ['Container', 'Tiêu đề', 'Rev', 'Tình trạng', ''].map((x) => h('th', {}, x)))),
        h('tbody', {}, t.items.map((it) => h('tr', {},
          h('td', { class: 'mono' }, it.name), h('td', {}, it.title), h('td', { class: 'mono' }, it.revision), h('td', { class: 'mono' }, it.statusCode),
          h('td', {}, h('a', { href: `/api/versions/${it.versionId}/download` }, 'Tải về'))))))))) : h('div', { class: 'panel empty' }, 'Chưa có phiếu chuyển giao'));
}

async function createTransmittalDialog() {
  const containers = (await api('GET', `/api/projects/${PROJECT.id}/containers`)).filter((c) => c.state === 'SHARED' || c.state === 'PUBLISHED');
  const close = openModal('Tạo phiếu chuyển giao', h('form', {
    onsubmit: action(async (e) => {
      const d = formData(e.target);
      d.recipientIds = [].concat(d.recipientIds || []);
      d.containerIds = [].concat(d.containerIds || []);
      const t = await api('POST', `/api/projects/${PROJECT.id}/transmittals`, d);
      close();
      toast(`Đã tạo ${t.ref}`);
      reload();
    }),
  },
  h('div', { class: 'form-grid' },
    h('label', { style: 'grid-column: span 2' }, 'Tiêu đề', h('input', { name: 'subject', required: true })),
    h('label', {}, 'Mục đích', h('select', { name: 'purpose' }, ['Để thông tin', 'Để góp ý', 'Để phê duyệt', 'Để thi công', 'Để đấu thầu', 'Hồ sơ hoàn công'].map((p) => h('option', {}, p))))),
  h('label', {}, 'Người nhận'),
  h('div', { class: 'checklist' }, PROJECT.members.filter((m) => m.id !== ME.id).map((m) =>
    h('label', {}, h('input', { type: 'checkbox', name: 'recipientIds', value: m.id }), `${m.name} (${m.org}) – ${META.projectRoles[m.role]}`))),
  h('label', {}, 'Container (chỉ trạng thái Shared/Published)'),
  containers.length
    ? h('div', { class: 'checklist' }, containers.map((c) =>
      h('label', {}, h('input', { type: 'checkbox', name: 'containerIds', value: c.id }), h('span', { class: 'mono' }, `${c.name} ${c.revision}`), stateBadge(c.state), h('span', { class: 'muted' }, c.title))))
    : h('p', { class: 'notice' }, 'Chưa có container nào ở trạng thái Shared/Published.'),
  h('label', {}, 'Lời nhắn', h('textarea', { name: 'message' })),
  h('button', { class: 'primary', type: 'submit' }, 'Gửi')));
}

// --- Thành viên
async function viewMembers(view) {
  const isManager = PROJECT.myRole === 'manager';
  const roleSelect = (m) => h('select', {
    style: 'max-width:240px',
    onchange: action(async (e) => { await api('PUT', `/api/projects/${PROJECT.id}/members`, { userId: m.id, role: e.target.value }); toast('Đã cập nhật vai trò'); reload(); }),
  }, options(META.projectRoles, m.role));
  view.append(h('div', { class: 'panel table-wrap' },
    h('div', { class: 'row', style: 'margin-bottom:10px' }, h('h2', { style: 'margin:0' }, 'Thành viên dự án'), h('span', { class: 'spacer' }),
      ME.isAdmin && h('button', { onclick: createUserDialog }, '+ Người dùng mới'),
      isManager && h('button', { class: 'primary', onclick: addMemberDialog }, '+ Thêm thành viên')),
    h('table', {},
      h('thead', {}, h('tr', {}, ['Họ tên', 'Tên đăng nhập', 'Đơn vị', 'Email', 'Vai trò', ''].map((t) => h('th', {}, t)))),
      h('tbody', {}, PROJECT.members.map((m) => h('tr', {},
        h('td', {}, m.name), h('td', { class: 'mono' }, m.username), h('td', { class: 'mono' }, m.org), h('td', { class: 'small' }, m.email || '—'),
        h('td', {}, isManager ? roleSelect(m) : META.projectRoles[m.role]),
        h('td', {}, isManager && h('button', {
          class: 'danger',
          onclick: action(async () => {
            if (!confirm(`Gỡ ${m.name} khỏi dự án?`)) return;
            await api('DELETE', `/api/projects/${PROJECT.id}/members/${m.id}`);
            reload();
          }),
        }, 'Gỡ'))))))),
  h('div', { class: 'panel' }, h('h3', {}, 'Ma trận quyền'),
    h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, ['Vai trò', 'Xem Shared/Published', 'Tạo & tải lên WIP (đơn vị mình)', 'Duyệt WIP → Shared', 'Duyệt Shared → Published, lưu trữ, quản lý thành viên'].map((t) => h('th', {}, t)))),
      h('tbody', {}, Object.entries(META.projectRoles).map(([k, label]) => h('tr', {},
        h('td', {}, label), ...['viewer', 'member', 'lead', 'manager'].map((min) => h('td', {}, atLeast(k, min) ? '✓' : '—')))))))));
}

async function addMemberDialog() {
  const users = (await api('GET', '/api/users')).filter((u) => !PROJECT.members.some((m) => m.id === u.id));
  if (!users.length) return toast('Tất cả người dùng đã thuộc dự án. Quản trị viên có thể tạo thêm người dùng.', true);
  const close = openModal('Thêm thành viên', h('form', {
    onsubmit: action(async (e) => {
      await api('PUT', `/api/projects/${PROJECT.id}/members`, formData(e.target));
      close();
      reload();
    }),
  },
  h('label', {}, 'Người dùng', h('select', { name: 'userId' }, users.map((u) => h('option', { value: u.id }, `${u.name} (${u.username} · ${u.org})`)))),
  h('label', {}, 'Vai trò', h('select', { name: 'role' }, options(META.projectRoles, 'member'))),
  h('button', { class: 'primary', type: 'submit' }, 'Thêm')));
}

// --- Nhật ký
async function viewActivity(view) {
  const items = await api('GET', `/api/projects/${PROJECT.id}/activity`);
  view.append(h('div', { class: 'panel' }, h('h2', {}, 'Nhật ký kiểm tra (audit trail)'), activityFeed(items)));
}

boot();
