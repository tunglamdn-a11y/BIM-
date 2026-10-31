'use strict';
// Máy chủ CDE – không phụ thuộc thư viện ngoài (Node.js >= 18).
//   node server.js            chạy với dữ liệu trong ./data
//   node server.js --demo     tạo dữ liệu mẫu nếu CSDL đang trống

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Store } = require('./lib/store');
const cde = require('./lib/cde');

const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = process.env.CDE_DATA || path.join(__dirname, 'data');
const MAX_UPLOAD = (Number(process.env.CDE_MAX_UPLOAD_MB) || 500) * 1024 * 1024;
const SESSION_TTL = 12 * 3600 * 1000;
const PUBLIC_DIR = path.join(__dirname, 'public');

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const fail = (status, message) => {
  throw new HttpError(status, message);
};

// --- Mật khẩu & phiên -------------------------------------------------------
function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return { salt, hash };
}
function checkPassword(user, password) {
  const { hash } = hashPassword(password, user.salt);
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(user.hash, 'hex'));
}

// decodeURIComponent ném URIError với chuỗi mã hóa sai (vd. "100%").
function safeDecode(s, fallback = null) {
  try {
    return decodeURIComponent(s);
  } catch {
    return fallback;
  }
}

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = safeDecode(part.slice(i + 1).trim(), '');
  }
  return out;
}

const publicUser = (u) => u && { id: u.id, username: u.username, name: u.name, email: u.email, org: u.org, isAdmin: !!u.isAdmin };

function createApp(store) {
  const db = store.db;
  const routes = [];
  const route = (method, pattern, handler, opts = {}) => {
    const keys = [];
    const re = new RegExp(`^${pattern.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)'))}$`);
    routes.push({ method, re, keys, handler, isPublic: !!opts.public });
  };

  const now = () => new Date().toISOString();
  const userById = (id) => db.users.find((u) => u.id === id);
  const userName = (id) => (userById(id) || {}).name || '—';

  function currentUser(req) {
    const token = parseCookies(req).cde_session;
    const s = token && db.sessions[token];
    if (!s || s.exp < Date.now()) return null;
    return userById(s.userId) || null;
  }

  function projectAccess(user, projectId, minRole = 'viewer') {
    const project = db.projects.find((p) => p.id === projectId);
    if (!project) fail(404, 'Không tìm thấy dự án');
    const member = project.members.find((m) => m.userId === user.id) || null;
    if (!user.isAdmin && (!member || !cde.hasRole(member.role, minRole))) fail(403, 'Bạn không có quyền thực hiện thao tác này trong dự án');
    return { project, member, role: user.isAdmin ? 'manager' : member.role };
  }

  function containerAccess(user, containerId) {
    const container = db.containers.find((c) => c.id === containerId);
    if (!container) fail(404, 'Không tìm thấy container thông tin');
    const access = projectAccess(user, container.projectId);
    if (!cde.canView(access.member, user, container)) fail(404, 'Không tìm thấy container thông tin');
    return { container, ...access };
  }

  // Người không thuộc đơn vị tạo lập chỉ thấy các phiên bản đã chia sẻ/phát hành.
  function visibleVersions(container, user, member) {
    if (cde.canEditWip(member, user, container)) return container.versions;
    return container.versions.filter((v) => v.state !== 'WIP');
  }

  const pendingWorkflow = (containerId) => db.workflows.find((w) => w.containerId === containerId && w.decision === 'pending');

  function containerView(c, user, member, full = false) {
    const versions = visibleVersions(c, user, member);
    const latest = versions[versions.length - 1] || null;
    const wf = pendingWorkflow(c.id);
    const view = {
      id: c.id,
      projectId: c.projectId,
      name: c.name,
      fields: c.fields,
      title: c.title,
      description: c.description,
      state: c.state,
      statusCode: c.statusCode,
      revision: latest ? latest.revision : null,
      latestVersionId: latest ? latest.id : null,
      fileName: latest ? latest.fileName : null,
      size: latest ? latest.size : null,
      createdBy: userName(c.createdBy),
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
      pending: wf ? { id: wf.id, to: wf.to, statusCode: wf.statusCode } : null,
      canEdit: cde.canEditWip(member, user, c),
    };
    if (full) {
      view.versions = versions.map((v) => ({ ...v, storedAs: undefined, by: userName(v.by) })).reverse();
      view.workflows = db.workflows
        .filter((w) => w.containerId === c.id)
        .map((w) => workflowView(w))
        .reverse();
      view.issues = db.issues.filter((i) => i.containerIds.includes(c.id)).map((i) => ({ id: i.id, ref: i.ref, title: i.title, status: i.status }));
    }
    return view;
  }

  function workflowView(w) {
    const c = db.containers.find((x) => x.id === w.containerId);
    return {
      ...w,
      containerName: c ? c.name : '—',
      containerTitle: c ? c.title : '',
      requestedByName: userName(w.requestedBy),
      decidedByName: w.decidedBy ? userName(w.decidedBy) : null,
      label: (cde.transition(w.from, w.to) || {}).label,
    };
  }

  // Thêm một bản ghi phiên bản trỏ tới tệp của phiên bản đã được gửi duyệt, với revision/trạng thái mới.
  function stampVersion(container, sourceVersionId, state, statusCode, userId, note) {
    const revisions = container.versions.map((v) => v.revision);
    const source = container.versions.find((v) => v.id === sourceVersionId);
    if (!source) fail(409, 'Không tìm thấy phiên bản đã gửi duyệt');
    const revision = state === 'SHARED' ? cde.sharedRevision(revisions) : cde.publishedRevision(revisions);
    container.versions.push({ ...source, id: store.id(), revision, state, statusCode, by: userId, at: now(), note: note || '' });
    return revision;
  }

  function applyTransition(container, to, statusCode, userId, note, sourceVersionId) {
    const from = container.state;
    let revision = null;
    if (to === 'SHARED' || to === 'PUBLISHED') revision = stampVersion(container, sourceVersionId, to, statusCode, userId, note);
    container.state = to;
    container.statusCode = statusCode;
    container.updatedAt = now();
    store.log(container.projectId, userId, 'transition', `${container.name}: ${from} → ${to} (${statusCode}${revision ? `, ${revision}` : ''})`);
  }

  // ---------------------------------------------------------------- Auth
  route('POST', '/api/login', async ({ body, res }) => {
    const user = db.users.find((u) => u.username === String(body.username || '').trim().toLowerCase());
    if (!user || !checkPassword(user, body.password || '')) fail(401, 'Sai tên đăng nhập hoặc mật khẩu');
    const token = crypto.randomBytes(32).toString('hex');
    for (const [t, s] of Object.entries(db.sessions)) if (s.exp < Date.now()) delete db.sessions[t];
    db.sessions[token] = { userId: user.id, exp: Date.now() + SESSION_TTL };
    store.save();
    res.setHeader('Set-Cookie', `cde_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL / 1000}`);
    return publicUser(user);
  }, { public: true });

  route('POST', '/api/logout', async ({ req, res }) => {
    delete db.sessions[parseCookies(req).cde_session];
    store.save();
    res.setHeader('Set-Cookie', 'cde_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
    return { ok: true };
  });

  route('GET', '/api/me', async ({ user }) => publicUser(user));

  route('POST', '/api/me/password', async ({ user, body }) => {
    if (!checkPassword(user, body.oldPassword || '')) fail(400, 'Mật khẩu hiện tại không đúng');
    if (String(body.newPassword || '').length < 6) fail(400, 'Mật khẩu mới cần ít nhất 6 ký tự');
    Object.assign(user, hashPassword(body.newPassword));
    store.save();
    return { ok: true };
  });

  route('GET', '/api/meta', async () => ({
    states: cde.STATES,
    stateLabels: cde.STATE_LABELS,
    statusCodes: cde.STATUS_CODES,
    typeCodes: cde.TYPE_CODES,
    roleCodes: cde.ROLE_CODES,
    projectRoles: cde.PROJECT_ROLES,
    fieldRules: Object.fromEntries(Object.entries(cde.FIELD_RULES).map(([k, r]) => [k, { label: r.label, hint: r.hint }])),
    fieldOrder: cde.FIELD_ORDER,
    transitions: cde.TRANSITIONS,
    maxUploadMb: MAX_UPLOAD / 1024 / 1024,
  }));

  // ---------------------------------------------------------------- Users
  route('GET', '/api/users', async () => db.users.map(publicUser));

  route('POST', '/api/users', async ({ user, body }) => {
    if (!user.isAdmin) fail(403, 'Chỉ quản trị viên được tạo người dùng');
    const username = String(body.username || '').trim().toLowerCase();
    if (!/^[a-z0-9._-]{3,32}$/.test(username)) fail(400, 'Tên đăng nhập 3–32 ký tự (a-z, 0-9, . _ -)');
    if (db.users.some((u) => u.username === username)) fail(409, 'Tên đăng nhập đã tồn tại');
    const org = String(body.org || '').trim().toUpperCase();
    if (!cde.FIELD_RULES.originator.re.test(org)) fail(400, 'Mã đơn vị cần 3–6 ký tự chữ/số');
    if (String(body.password || '').length < 6) fail(400, 'Mật khẩu cần ít nhất 6 ký tự');
    const u = {
      id: store.id(),
      username,
      name: String(body.name || username).trim(),
      email: String(body.email || '').trim(),
      org,
      isAdmin: !!body.isAdmin,
      ...hashPassword(body.password),
      createdAt: now(),
    };
    db.users.push(u);
    store.log(null, user.id, 'user.create', `Tạo người dùng ${u.username} (${u.org})`);
    store.save();
    return publicUser(u);
  });

  // ---------------------------------------------------------------- Projects
  route('GET', '/api/projects', async ({ user }) =>
    db.projects
      .filter((p) => user.isAdmin || p.members.some((m) => m.userId === user.id))
      .map((p) => ({
        ...p,
        members: undefined,
        memberCount: p.members.length,
        myRole: user.isAdmin ? 'manager' : p.members.find((m) => m.userId === user.id).role,
        containerCount: db.containers.filter((c) => c.projectId === p.id).length,
        openIssues: db.issues.filter((i) => i.projectId === p.id && !['resolved', 'closed'].includes(i.status)).length,
      })));

  route('POST', '/api/projects', async ({ user, body }) => {
    if (!user.isAdmin) fail(403, 'Chỉ quản trị viên được tạo dự án');
    const code = String(body.code || '').trim().toUpperCase();
    if (!cde.FIELD_RULES.project.re.test(code)) fail(400, 'Mã dự án cần 2–6 ký tự chữ/số');
    if (db.projects.some((p) => p.code === code)) fail(409, 'Mã dự án đã tồn tại');
    if (!String(body.name || '').trim()) fail(400, 'Vui lòng nhập tên dự án');
    const p = {
      id: store.id(),
      code,
      name: String(body.name).trim(),
      client: String(body.client || '').trim(),
      location: String(body.location || '').trim(),
      stage: String(body.stage || '').trim(),
      description: String(body.description || '').trim(),
      createdAt: now(),
      members: [{ userId: user.id, role: 'manager' }],
    };
    db.projects.push(p);
    store.log(p.id, user.id, 'project.create', `Tạo dự án ${p.code} – ${p.name}`);
    store.save();
    return p;
  });

  route('GET', '/api/projects/:pid', async ({ user, params }) => {
    const { project, role } = projectAccess(user, params.pid);
    return {
      ...project,
      myRole: role,
      members: project.members.map((m) => ({ ...publicUser(userById(m.userId)), role: m.role })),
    };
  });

  route('PATCH', '/api/projects/:pid', async ({ user, params, body }) => {
    const { project } = projectAccess(user, params.pid, 'manager');
    for (const k of ['name', 'client', 'location', 'stage', 'description']) if (k in body) project[k] = String(body[k]).trim();
    store.log(project.id, user.id, 'project.update', 'Cập nhật thông tin dự án');
    store.save();
    return project;
  });

  route('PUT', '/api/projects/:pid/members', async ({ user, params, body }) => {
    const { project } = projectAccess(user, params.pid, 'manager');
    const target = userById(body.userId);
    if (!target) fail(404, 'Không tìm thấy người dùng');
    if (!cde.isCode(cde.PROJECT_ROLES, body.role)) fail(400, 'Vai trò không hợp lệ');
    const existing = project.members.find((m) => m.userId === target.id);
    if (existing && body.role !== 'manager' && !project.members.some((m) => m !== existing && m.role === 'manager'))
      fail(400, 'Dự án cần ít nhất một người quản lý thông tin');
    if (existing) existing.role = body.role;
    else project.members.push({ userId: target.id, role: body.role });
    store.log(project.id, user.id, 'member.set', `${target.name}: ${cde.PROJECT_ROLES[body.role]}`);
    store.save();
    return { ok: true };
  });

  route('DELETE', '/api/projects/:pid/members/:uid', async ({ user, params }) => {
    const { project } = projectAccess(user, params.pid, 'manager');
    const remaining = project.members.filter((m) => m.userId !== params.uid);
    if (!remaining.some((m) => m.role === 'manager')) fail(400, 'Dự án cần ít nhất một người quản lý thông tin');
    project.members = remaining;
    store.log(project.id, user.id, 'member.remove', `Gỡ ${userName(params.uid)} khỏi dự án`);
    store.save();
    return { ok: true };
  });

  route('GET', '/api/projects/:pid/dashboard', async ({ user, params }) => {
    const { project, member, role } = projectAccess(user, params.pid);
    const containers = db.containers.filter((c) => c.projectId === project.id && cde.canView(member, user, c));
    const byState = Object.fromEntries(cde.STATES.map((s) => [s, 0]));
    const byRole = {};
    for (const c of containers) {
      byState[c.state]++;
      byRole[c.fields.role] = (byRole[c.fields.role] || 0) + 1;
    }
    const issues = db.issues.filter((i) => i.projectId === project.id);
    const issuesByStatus = {};
    for (const i of issues) issuesByStatus[i.status] = (issuesByStatus[i.status] || 0) + 1;
    const today = now().slice(0, 10);
    const pending = db.workflows.filter((w) => w.projectId === project.id && w.decision === 'pending');
    return {
      byState,
      byRole,
      issuesByStatus,
      overdueIssues: issues.filter((i) => i.dueDate && i.dueDate < today && !['resolved', 'closed'].includes(i.status)).length,
      myIssues: issues.filter((i) => i.assigneeId === user.id && !['resolved', 'closed'].includes(i.status)).length,
      pendingApprovals: pending.length,
      myApprovals: pending.filter((w) => cde.hasRole(role, cde.transition(w.from, w.to).approverRole)).length,
      transmittals: db.transmittals.filter((t) => t.projectId === project.id).length,
      recent: db.activity
        .filter((a) => a.projectId === project.id)
        .slice(-8)
        .reverse()
        .map((a) => ({ ...a, userName: userName(a.userId) })),
    };
  });

  route('GET', '/api/projects/:pid/activity', async ({ user, params }) => {
    projectAccess(user, params.pid);
    return db.activity
      .filter((a) => a.projectId === params.pid)
      .slice(-500)
      .reverse()
      .map((a) => ({ ...a, userName: userName(a.userId) }));
  });

  // ---------------------------------------------------------------- Containers
  route('GET', '/api/projects/:pid/containers', async ({ user, params, query }) => {
    const { project, member } = projectAccess(user, params.pid);
    const q = (query.get('q') || '').toLowerCase();
    const state = query.get('state');
    return db.containers
      .filter((c) => c.projectId === project.id && cde.canView(member, user, c))
      .filter((c) => !state || c.state === state)
      .filter((c) => !q || `${c.name} ${c.title} ${c.description}`.toLowerCase().includes(q))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((c) => containerView(c, user, member));
  });

  route('GET', '/api/projects/:pid/next-number', async ({ user, params, query }) => {
    const { project } = projectAccess(user, params.pid);
    const prefix = cde.buildName(cde.normalizeFields({ ...Object.fromEntries(query), project: project.code, number: '' }));
    let max = 0;
    for (const c of db.containers) if (c.projectId === project.id && c.name.startsWith(prefix)) max = Math.max(max, Number(c.fields.number));
    return { number: String(max + 1).padStart(4, '0') };
  });

  route('POST', '/api/projects/:pid/containers', async ({ user, params, body }) => {
    const { project, member } = projectAccess(user, params.pid, 'member');
    const fields = cde.normalizeFields({ ...body.fields, project: project.code });
    if (!user.isAdmin && member.role !== 'manager' && fields.originator !== user.org)
      fail(403, `Bạn chỉ được tạo container với mã đơn vị của mình (${user.org})`);
    const errors = cde.validateFields(fields);
    if (errors.length) fail(400, errors.join('; '));
    const name = cde.buildName(fields);
    if (db.containers.some((c) => c.projectId === project.id && c.name === name)) fail(409, `Tên ${name} đã tồn tại trong dự án`);
    if (!String(body.title || '').trim()) fail(400, 'Vui lòng nhập tiêu đề');
    const c = {
      id: store.id(),
      projectId: project.id,
      name,
      fields,
      title: String(body.title).trim(),
      description: String(body.description || '').trim(),
      state: 'WIP',
      statusCode: 'S0',
      versions: [],
      createdBy: user.id,
      createdAt: now(),
      updatedAt: now(),
    };
    db.containers.push(c);
    store.log(project.id, user.id, 'container.create', `Tạo ${name} – ${c.title}`);
    store.save();
    return containerView(c, user, member);
  });

  route('GET', '/api/containers/:cid', async ({ user, params }) => {
    const { container, member } = containerAccess(user, params.cid);
    return containerView(container, user, member, true);
  });

  route('PATCH', '/api/containers/:cid', async ({ user, params, body }) => {
    const { container, member } = containerAccess(user, params.cid);
    if (container.state !== 'WIP' || !cde.canEditWip(member, user, container)) fail(403, 'Chỉ sửa được thông tin khi container ở trạng thái WIP và thuộc đơn vị của bạn');
    if ('title' in body) {
      if (!String(body.title).trim()) fail(400, 'Tiêu đề không được để trống');
      container.title = String(body.title).trim();
    }
    if ('description' in body) container.description = String(body.description).trim();
    container.updatedAt = now();
    store.log(container.projectId, user.id, 'container.update', `Cập nhật thông tin ${container.name}`);
    store.save();
    return containerView(container, user, member);
  });

  // Tải lên phiên bản mới: thân yêu cầu là nội dung tệp; tên tệp trong header X-File-Name.
  route('PUT', '/api/containers/:cid/versions', async ({ req, user, params, query }) => {
    const { container, member } = containerAccess(user, params.cid);
    if (container.state !== 'WIP') fail(409, 'Chỉ tải phiên bản mới khi container ở trạng thái WIP');
    if (!cde.canEditWip(member, user, container)) fail(403, 'Bạn không có quyền tải lên container này');
    if (pendingWorkflow(container.id)) fail(409, 'Container đang chờ phê duyệt, không thể tải lên');
    const rawName = safeDecode(req.headers['x-file-name'] || '');
    if (rawName === null) fail(400, 'Tên tệp không hợp lệ');
    const fileName = path.basename(rawName).slice(0, 255);
    if (!fileName) fail(400, 'Thiếu tên tệp');
    const storedAs = store.id();
    const dest = store.filePath(storedAs);
    const hash = crypto.createHash('sha256');
    let size = 0;
    await new Promise((resolve, reject) => {
      const out = fs.createWriteStream(dest);
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_UPLOAD) {
          req.destroy();
          out.destroy();
          reject(new HttpError(413, `Tệp vượt quá ${MAX_UPLOAD / 1024 / 1024} MB`));
          return;
        }
        hash.update(chunk);
        if (!out.write(chunk)) req.pause();
      });
      out.on('drain', () => req.resume());
      req.on('end', () => out.end(resolve));
      req.on('error', reject);
      out.on('error', reject);
    }).catch((err) => {
      fs.rmSync(dest, { force: true });
      throw err;
    });
    if (size === 0) {
      fs.rmSync(dest, { force: true });
      fail(400, 'Tệp rỗng');
    }
    // Trạng thái có thể đã thay đổi trong lúc đang nhận tệp.
    if (container.state !== 'WIP' || pendingWorkflow(container.id)) {
      fs.rmSync(dest, { force: true });
      fail(409, 'Container đã chuyển trạng thái hoặc đang chờ phê duyệt trong lúc tải lên');
    }
    const revision = cde.nextWipRevision(container.versions.map((v) => v.revision));
    container.versions.push({
      id: store.id(),
      revision,
      state: 'WIP',
      statusCode: 'S0',
      fileName,
      size,
      mime: String(req.headers['content-type'] || 'application/octet-stream').slice(0, 100),
      sha256: hash.digest('hex'),
      storedAs,
      by: user.id,
      at: now(),
      note: String(query.get('note') || '').slice(0, 500),
    });
    container.updatedAt = now();
    store.log(container.projectId, user.id, 'version.upload', `${container.name} ${revision}: ${fileName}`);
    store.save();
    return containerView(container, user, member, true);
  });

  route('GET', '/api/versions/:vid/download', async ({ user, params, res }) => {
    const container = db.containers.find((c) => c.versions.some((v) => v.id === params.vid));
    if (!container) fail(404, 'Không tìm thấy phiên bản');
    const { member } = containerAccess(user, container.id);
    const version = visibleVersions(container, user, member).find((v) => v.id === params.vid);
    if (!version) fail(404, 'Không tìm thấy phiên bản');
    const file = store.filePath(version.storedAs);
    if (!fs.existsSync(file)) fail(410, 'Tệp không còn trên máy chủ');
    const ext = path.extname(version.fileName);
    const downloadName = `${container.name}-${version.revision}${ext}`;
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': version.size,
      'Content-Disposition': `attachment; filename="${downloadName.replace(/[^\w.-]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(downloadName)}`,
    });
    fs.createReadStream(file).pipe(res);
    return undefined;
  });

  // Yêu cầu chuyển trạng thái. Chuyển "direct" thực hiện ngay nếu đủ quyền;
  // các chuyển còn lại tạo yêu cầu phê duyệt.
  route('POST', '/api/containers/:cid/transition', async ({ user, params, body }) => {
    const { container, member, role } = containerAccess(user, params.cid);
    const t = cde.transition(container.state, body.to);
    if (!t) fail(400, `Không thể chuyển từ ${container.state} sang ${body.to}`);
    if (pendingWorkflow(container.id)) fail(409, 'Container đã có yêu cầu đang chờ phê duyệt');
    const statusCode = body.to === 'WIP' ? 'S0' : body.to === 'ARCHIVED' ? 'AR' : String(body.statusCode || '');
    if (!cde.isCode(cde.STATUS_CODES[body.to], statusCode)) fail(400, 'Mã tình trạng không hợp lệ cho trạng thái đích');
    const comment = String(body.comment || '').trim().slice(0, 2000);

    if (t.direct) {
      if (!cde.hasRole(role, t.approverRole)) fail(403, 'Bạn không đủ quyền thực hiện thao tác này');
      if (body.to === 'WIP' && !cde.canEditWip(member, user, container)) fail(403, 'Chỉ đơn vị tạo lập được đưa container về WIP');
      applyTransition(container, body.to, statusCode, user.id, comment);
      store.save();
      return { done: true, container: containerView(container, user, member) };
    }

    if (!cde.canEditWip(member, user, container)) fail(403, 'Chỉ đơn vị tạo lập được gửi yêu cầu cho container này');
    const last = container.versions[container.versions.length - 1];
    if (!last) fail(400, 'Container chưa có tệp nào');
    if (body.to === 'SHARED' && last.state !== 'WIP') fail(400, 'Cần tải lên phiên bản WIP mới trước khi chia sẻ lại');
    const wf = {
      id: store.id(),
      projectId: container.projectId,
      containerId: container.id,
      from: container.state,
      to: body.to,
      statusCode,
      versionId: last.id,
      revision: last.revision,
      comment,
      requestedBy: user.id,
      requestedAt: now(),
      decision: 'pending',
    };
    db.workflows.push(wf);
    store.log(container.projectId, user.id, 'workflow.request', `Yêu cầu "${t.label}" cho ${container.name} (${statusCode})`);
    store.save();
    return { done: false, workflow: workflowView(wf) };
  });

  route('GET', '/api/projects/:pid/workflows', async ({ user, params, query }) => {
    const { project, member, role } = projectAccess(user, params.pid);
    const status = query.get('status');
    return db.workflows
      .filter((w) => w.projectId === project.id && (!status || w.decision === status))
      .filter((w) => {
        const c = db.containers.find((x) => x.id === w.containerId);
        return c && cde.canView(member, user, c);
      })
      .map((w) => ({ ...workflowView(w), canDecide: w.decision === 'pending' && cde.hasRole(role, cde.transition(w.from, w.to).approverRole) }))
      .reverse();
  });

  route('POST', '/api/workflows/:wid/decision', async ({ user, params, body }) => {
    const wf = db.workflows.find((w) => w.id === params.wid);
    if (!wf) fail(404, 'Không tìm thấy yêu cầu');
    if (wf.decision !== 'pending') fail(409, 'Yêu cầu đã được xử lý');
    const { container, role } = containerAccess(user, wf.containerId);
    const t = cde.transition(wf.from, wf.to);
    if (!cde.hasRole(role, t.approverRole)) fail(403, `Cần vai trò "${cde.PROJECT_ROLES[t.approverRole]}" để phê duyệt`);
    if (body.approve && wf.requestedBy === user.id && !user.isAdmin) fail(403, 'Người gửi yêu cầu không được tự phê duyệt');
    const comment = String(body.comment || '').trim().slice(0, 2000);
    if (!body.approve && !comment) fail(400, 'Vui lòng ghi lý do từ chối');
    if (body.approve && container.state !== wf.from) fail(409, 'Trạng thái container đã thay đổi');
    wf.decision = body.approve ? 'approved' : 'rejected';
    wf.decidedBy = user.id;
    wf.decidedAt = now();
    wf.decisionComment = comment;
    if (body.approve) {
      applyTransition(container, wf.to, wf.statusCode, user.id, comment, wf.versionId);
    } else {
      store.log(container.projectId, user.id, 'workflow.reject', `Từ chối "${t.label}" cho ${container.name}: ${comment}`);
    }
    store.save();
    return workflowView(wf);
  });

  // ---------------------------------------------------------------- Issues / RFI
  const ISSUE_TYPES = ['RFI', 'ISSUE', 'CLASH', 'NCR'];
  const ISSUE_STATUS = ['open', 'in_progress', 'resolved', 'closed'];
  const PRIORITIES = ['low', 'medium', 'high', 'critical'];

  const issueView = (i, user, member) => ({
    ...i,
    createdByName: userName(i.createdBy),
    assigneeName: i.assigneeId ? userName(i.assigneeId) : null,
    containers: i.containerIds
      .map((id) => db.containers.find((c) => c.id === id))
      .filter((c) => c && cde.canView(member, user, c))
      .map((c) => ({ id: c.id, name: c.name, title: c.title })),
    comments: i.comments.map((cm) => ({ ...cm, userName: userName(cm.userId) })),
  });

  route('GET', '/api/projects/:pid/issues', async ({ user, params }) => {
    const { project, member } = projectAccess(user, params.pid);
    return db.issues.filter((i) => i.projectId === project.id).map((i) => issueView(i, user, member)).reverse();
  });

  route('POST', '/api/projects/:pid/issues', async ({ user, params, body }) => {
    const { project, member } = projectAccess(user, params.pid, 'member');
    const type = ISSUE_TYPES.includes(body.type) ? body.type : 'ISSUE';
    if (!String(body.title || '').trim()) fail(400, 'Vui lòng nhập tiêu đề');
    if (body.assigneeId && !project.members.some((m) => m.userId === body.assigneeId)) fail(400, 'Người được giao không thuộc dự án');
    const containerIds = (Array.isArray(body.containerIds) ? body.containerIds : []).filter((id) =>
      db.containers.some((c) => c.id === id && c.projectId === project.id && cde.canView(member, user, c)));
    const n = store.nextSeq(`issue:${project.id}:${type}`);
    const issue = {
      id: store.id(),
      projectId: project.id,
      ref: `${project.code}-${type}-${String(n).padStart(4, '0')}`,
      type,
      title: String(body.title).trim(),
      description: String(body.description || '').trim(),
      priority: PRIORITIES.includes(body.priority) ? body.priority : 'medium',
      status: 'open',
      assigneeId: body.assigneeId || null,
      dueDate: /^\d{4}-\d{2}-\d{2}$/.test(body.dueDate || '') ? body.dueDate : null,
      containerIds,
      comments: [],
      createdBy: user.id,
      createdAt: now(),
      updatedAt: now(),
    };
    db.issues.push(issue);
    store.log(project.id, user.id, 'issue.create', `${issue.ref}: ${issue.title}`);
    store.save();
    return issueView(issue, user, member);
  });

  route('PATCH', '/api/issues/:iid', async ({ user, params, body }) => {
    const issue = db.issues.find((i) => i.id === params.iid);
    if (!issue) fail(404, 'Không tìm thấy vấn đề');
    const { project, member, role } = projectAccess(user, issue.projectId, 'member');
    const changes = [];
    if (body.status && body.status !== issue.status) {
      if (!ISSUE_STATUS.includes(body.status)) fail(400, 'Trạng thái không hợp lệ');
      if (body.status === 'closed' && issue.createdBy !== user.id && !cde.hasRole(role, 'lead'))
        fail(403, 'Chỉ người tạo hoặc trưởng nhóm được đóng vấn đề');
      changes.push(`trạng thái ${issue.status} → ${body.status}`);
      issue.status = body.status;
    }
    if ('assigneeId' in body && body.assigneeId !== issue.assigneeId) {
      if (body.assigneeId && !project.members.some((m) => m.userId === body.assigneeId)) fail(400, 'Người được giao không thuộc dự án');
      issue.assigneeId = body.assigneeId || null;
      changes.push(`giao cho ${issue.assigneeId ? userName(issue.assigneeId) : '—'}`);
    }
    if (body.priority && body.priority !== issue.priority && PRIORITIES.includes(body.priority)) {
      issue.priority = body.priority;
      changes.push(`ưu tiên ${body.priority}`);
    }
    if ('dueDate' in body && body.dueDate !== issue.dueDate) {
      issue.dueDate = /^\d{4}-\d{2}-\d{2}$/.test(body.dueDate || '') ? body.dueDate : null;
      changes.push(`hạn ${issue.dueDate || '—'}`);
    }
    if (changes.length) {
      issue.updatedAt = now();
      issue.comments.push({ id: store.id(), userId: user.id, at: now(), text: `Đã cập nhật: ${changes.join(', ')}`, system: true });
      store.log(issue.projectId, user.id, 'issue.update', `${issue.ref}: ${changes.join(', ')}`);
      store.save();
    }
    return issueView(issue, user, member);
  });

  route('POST', '/api/issues/:iid/comments', async ({ user, params, body }) => {
    const issue = db.issues.find((i) => i.id === params.iid);
    if (!issue) fail(404, 'Không tìm thấy vấn đề');
    const { member } = projectAccess(user, issue.projectId);
    const text = String(body.text || '').trim().slice(0, 5000);
    if (!text) fail(400, 'Nội dung trống');
    issue.comments.push({ id: store.id(), userId: user.id, at: now(), text });
    issue.updatedAt = now();
    store.log(issue.projectId, user.id, 'issue.comment', `Bình luận ${issue.ref}`);
    store.save();
    return issueView(issue, user, member);
  });

  // ---------------------------------------------------------------- Transmittals
  const transmittalView = (t, user) => ({
    ...t,
    fromName: userName(t.from),
    recipients: t.recipientIds.map((id) => ({ id, name: userName(id), acknowledgedAt: t.acks[id] || null })),
    mustAcknowledge: t.recipientIds.includes(user.id) && !t.acks[user.id],
  });

  route('GET', '/api/projects/:pid/transmittals', async ({ user, params }) => {
    const { project } = projectAccess(user, params.pid);
    return db.transmittals.filter((t) => t.projectId === project.id).map((t) => transmittalView(t, user)).reverse();
  });

  route('POST', '/api/projects/:pid/transmittals', async ({ user, params, body }) => {
    const { project, member } = projectAccess(user, params.pid, 'member');
    if (!String(body.subject || '').trim()) fail(400, 'Vui lòng nhập tiêu đề');
    const recipientIds = [...new Set(Array.isArray(body.recipientIds) ? body.recipientIds : [])].filter((id) =>
      project.members.some((m) => m.userId === id));
    if (!recipientIds.length) fail(400, 'Chọn ít nhất một người nhận trong dự án');
    const items = [];
    for (const id of Array.isArray(body.containerIds) ? body.containerIds : []) {
      const c = db.containers.find((x) => x.id === id && x.projectId === project.id);
      if (!c || !cde.canView(member, user, c)) continue;
      if (c.state !== 'SHARED' && c.state !== 'PUBLISHED') fail(400, `${c.name} chưa được chia sẻ/phát hành – không thể chuyển giao`);
      const v = c.versions[c.versions.length - 1];
      items.push({ containerId: c.id, name: c.name, title: c.title, revision: v.revision, statusCode: c.statusCode, versionId: v.id });
    }
    if (!items.length) fail(400, 'Chọn ít nhất một container đã chia sẻ/phát hành');
    const n = store.nextSeq(`transmittal:${project.id}`);
    const t = {
      id: store.id(),
      projectId: project.id,
      ref: `${project.code}-TRN-${String(n).padStart(4, '0')}`,
      subject: String(body.subject).trim(),
      purpose: String(body.purpose || 'Để thông tin').trim(),
      message: String(body.message || '').trim(),
      from: user.id,
      recipientIds,
      items,
      acks: {},
      createdAt: now(),
    };
    db.transmittals.push(t);
    store.log(project.id, user.id, 'transmittal.create', `${t.ref}: ${t.subject} (${items.length} container)`);
    store.save();
    return transmittalView(t, user);
  });

  route('POST', '/api/transmittals/:tid/acknowledge', async ({ user, params }) => {
    const t = db.transmittals.find((x) => x.id === params.tid);
    if (!t) fail(404, 'Không tìm thấy phiếu chuyển giao');
    projectAccess(user, t.projectId);
    if (!t.recipientIds.includes(user.id)) fail(403, 'Bạn không phải người nhận');
    if (!t.acks[user.id]) {
      t.acks[user.id] = now();
      store.log(t.projectId, user.id, 'transmittal.ack', `Xác nhận nhận ${t.ref}`);
      store.save();
    }
    return transmittalView(t, user);
  });

  // ---------------------------------------------------------------- HTTP
  const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

  function serveStatic(req, res, pathname) {
    const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
    const file = path.normalize(path.join(PUBLIC_DIR, rel));
    if (!file.startsWith(PUBLIC_DIR + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    fs.createReadStream(file).pipe(res);
  }

  function readJson(req) {
    return new Promise((resolve, reject) => {
      let data = '';
      req.setEncoding('utf8');
      req.on('data', (chunk) => {
        data += chunk;
        if (data.length > 1e6) {
          req.destroy();
          reject(new HttpError(413, 'Dữ liệu quá lớn'));
        }
      });
      req.on('end', () => {
        if (!data) return resolve({});
        try {
          const parsed = JSON.parse(data);
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return reject(new HttpError(400, 'Dữ liệu phải là đối tượng JSON'));
          resolve(parsed);
        } catch {
          reject(new HttpError(400, 'JSON không hợp lệ'));
        }
      });
      req.on('error', reject);
    });
  }

  return async function handler(req, res) {
    const url = new URL(req.url, 'http://localhost');
    if (!url.pathname.startsWith('/api/')) return serveStatic(req, res, url.pathname);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    try {
      let match = null;
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = r.re.exec(url.pathname);
        if (m) {
          const params = Object.fromEntries(r.keys.map((k, i) => [k, safeDecode(m[i + 1])]));
          if (Object.values(params).includes(null)) fail(400, 'Đường dẫn không hợp lệ');
          match = { r, params };
          break;
        }
      }
      if (!match) fail(404, 'Không tìm thấy API');
      const user = currentUser(req);
      if (!user && !match.r.isPublic) fail(401, 'Vui lòng đăng nhập');
      const isUpload = req.method === 'PUT' && url.pathname.endsWith('/versions');
      const body = ['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method) && !isUpload ? await readJson(req) : {};
      const result = await match.r.handler({ req, res, user, params: match.params, query: url.searchParams, body });
      if (result !== undefined && !res.headersSent) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(result));
      }
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) console.error(err);
      if (!res.headersSent) {
        res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: status === 500 ? 'Lỗi máy chủ' : err.message }));
      }
    }
  };
}

function seedAdmin(store) {
  if (store.db.users.length) return;
  const password = process.env.CDE_ADMIN_PASSWORD || 'admin123';
  store.db.users.push({ id: store.id(), username: 'admin', name: 'Quản trị hệ thống', email: '', org: 'ADMIN', isAdmin: true, ...hashPassword(password), createdAt: new Date().toISOString() });
  store.save();
  console.log(`Đã tạo tài khoản quản trị: admin / ${password}  (hãy đổi mật khẩu sau khi đăng nhập)`);
}

module.exports = { createApp, seedAdmin, hashPassword };

if (require.main === module) {
  const store = new Store(DATA_DIR);
  seedAdmin(store);
  if (process.argv.includes('--demo')) require('./lib/demo').seedDemo(store, hashPassword);
  http.createServer(createApp(store)).listen(PORT, () => console.log(`CDE đang chạy tại http://localhost:${PORT}`));
}
