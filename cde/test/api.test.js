'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Store } = require('../lib/store');
const { createApp, seedAdmin, hashPassword } = require('../server');
const { seedDemo } = require('../lib/demo');

test('quy trình CDE đầy đủ qua API', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cde-'));
  const store = new Store(dir);
  seedAdmin(store);
  seedDemo(store, hashPassword);
  const server = http.createServer(createApp(store)).listen(0);
  t.after(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;

  async function login(username, password = 'demo123') {
    const res = await fetch(`${base}/api/login`, { method: 'POST', body: JSON.stringify({ username, password }) });
    assert.strictEqual(res.status, 200);
    const cookie = res.headers.get('set-cookie').split(';')[0];
    return async (method, url, body, headers = {}) => {
      const raw = body instanceof Buffer;
      const r = await fetch(base + url, { method, headers: { cookie, ...headers }, body: raw ? body : body && JSON.stringify(body) });
      const text = await r.text();
      let data;
      try { data = JSON.parse(text); } catch { data = text; }
      return { status: r.status, data };
    };
  }

  assert.strictEqual((await fetch(`${base}/api/projects`)).status, 401);
  const kt = await login('kt');
  const ktLead = await login('kt.lead');
  const kcLead = await login('kc.lead');
  const pm = await login('pm');
  const viewer = await login('xem');

  const [project] = (await kt('GET', '/api/projects')).data;
  const pid = project.id;

  // Thành viên KTA không được tạo container dưới mã đơn vị khác
  const bad = await kt('POST', `/api/projects/${pid}/containers`, { fields: { originator: 'KCB', volume: 'ZZ', level: '03', type: 'DR', role: 'S', number: '0001' }, title: 'x' });
  assert.strictEqual(bad.status, 403);

  const created = await kt('POST', `/api/projects/${pid}/containers`, { fields: { originator: 'KTA', volume: 'ZZ', level: '03', type: 'DR', role: 'A', number: '0103' }, title: 'Mặt bằng tầng 3' });
  assert.strictEqual(created.status, 200, JSON.stringify(created.data));
  const cid = created.data.id;
  assert.strictEqual(created.data.name, 'HN01-KTA-ZZ-03-DR-A-0103');

  // WIP không hiển thị với đơn vị khác
  assert.strictEqual((await kcLead('GET', `/api/containers/${cid}`)).status, 404);
  assert.strictEqual((await viewer('GET', `/api/containers/${cid}`)).status, 404);

  // Tải lên hai phiên bản WIP
  const up = (body) => kt('PUT', `/api/containers/${cid}/versions?note=v`, Buffer.from(body), { 'X-File-Name': encodeURIComponent('mặt bằng.pdf') });
  assert.strictEqual((await up('v1')).data.versions[0].revision, 'P01.1');
  assert.strictEqual((await up('v2')).data.versions[0].revision, 'P01.2');

  // Gửi yêu cầu chia sẻ; thành viên thường không duyệt được, trưởng nhóm duyệt được
  const req1 = await kt('POST', `/api/containers/${cid}/transition`, { to: 'SHARED', statusCode: 'S2' });
  assert.strictEqual(req1.data.done, false);
  assert.strictEqual((await up('v3')).status, 409, 'không tải lên khi đang chờ duyệt');
  assert.strictEqual((await kt('POST', `/api/workflows/${req1.data.workflow.id}/decision`, { approve: true })).status, 403);
  assert.strictEqual((await ktLead('POST', `/api/workflows/${req1.data.workflow.id}/decision`, { approve: true })).status, 200);
  assert.strictEqual((await kt('POST', `/api/containers/${cid}/transition`, { to: 'PUBLISHED', statusCode: 'constructor' })).status, 400);

  let c = (await viewer('GET', `/api/containers/${cid}`)).data;
  assert.strictEqual(c.state, 'SHARED');
  assert.strictEqual(c.revision, 'P01');
  assert.deepStrictEqual(c.versions.map((v) => v.revision), ['P01'], 'người xem không thấy phiên bản WIP');
  const dl = await viewer('GET', `/api/versions/${c.versions[0].id}/download`);
  assert.strictEqual(dl.data, 'v2');

  // Phát hành cần quản lý thông tin
  const req2 = await kt('POST', `/api/containers/${cid}/transition`, { to: 'PUBLISHED', statusCode: 'A1' });
  assert.strictEqual((await ktLead('POST', `/api/workflows/${req2.data.workflow.id}/decision`, { approve: true })).status, 403);
  assert.strictEqual((await pm('POST', `/api/workflows/${req2.data.workflow.id}/decision`, { approve: false })).status, 400, 'từ chối cần lý do');
  assert.strictEqual((await pm('POST', `/api/workflows/${req2.data.workflow.id}/decision`, { approve: true, comment: 'OK' })).status, 200);
  c = (await kt('GET', `/api/containers/${cid}`)).data;
  assert.strictEqual(c.state, 'PUBLISHED');
  assert.strictEqual(c.revision, 'C01');

  // Sửa đổi mới
  assert.strictEqual((await kt('POST', `/api/containers/${cid}/transition`, { to: 'WIP' })).data.done, true);
  assert.strictEqual((await up('v4')).data.versions[0].revision, 'P02.1');
  // Đơn vị khác vẫn thấy các bản đã phát hành, nhưng không thấy bản WIP mới
  c = (await viewer('GET', `/api/containers/${cid}`)).data;
  assert.deepStrictEqual(c.versions.map((v) => v.revision), ['C01', 'P01']);
  assert.strictEqual((await viewer('GET', `/api/versions/${c.versions[0].id}/download`)).data, 'v2');

  // RFI
  const pmId = (await pm('GET', '/api/me')).data.id;
  const issue = await kt('POST', `/api/projects/${pid}/issues`, { type: 'RFI', title: 'Cao độ sàn tầng 3?', assigneeId: pmId, containerIds: [cid] });
  assert.strictEqual(issue.data.ref, 'HN01-RFI-0001');
  assert.strictEqual((await viewer('POST', `/api/projects/${pid}/issues`, { title: 'x' })).status, 403);
  const commented = await pm('POST', `/api/issues/${issue.data.id}/comments`, { text: '+12.600' });
  assert.strictEqual(commented.data.comments.length, 1);
  assert.strictEqual((await pm('PATCH', `/api/issues/${issue.data.id}`, { status: 'resolved' })).data.status, 'resolved');

  // Chuyển giao: chỉ container Shared/Published; container WIP bị từ chối
  const viewerId = (await viewer('GET', '/api/me')).data.id;
  assert.strictEqual((await kt('POST', `/api/projects/${pid}/transmittals`, { subject: 'x', recipientIds: [viewerId], containerIds: [cid] })).status, 400);

  // Người gửi yêu cầu không tự phê duyệt được
  const own = await pm('POST', `/api/projects/${pid}/containers`, { fields: { originator: 'CDT', volume: 'ZZ', level: 'ZZ', type: 'PL', role: 'K', number: '0002' }, title: 'x' });
  await pm('PUT', `/api/containers/${own.data.id}/versions`, Buffer.from('x'), { 'X-File-Name': 'x.pdf' });
  const selfReq = await pm('POST', `/api/containers/${own.data.id}/transition`, { to: 'SHARED', statusCode: 'S2' });
  assert.strictEqual((await pm('POST', `/api/workflows/${selfReq.data.workflow.id}/decision`, { approve: true })).status, 403);

  // Không hạ cấp người quản lý duy nhất; vai trò kế thừa từ prototype bị từ chối
  assert.strictEqual((await pm('PUT', `/api/projects/${pid}/members`, { userId: pmId, role: 'viewer' })).status, 400);
  assert.strictEqual((await pm('PUT', `/api/projects/${pid}/members`, { userId: viewerId, role: 'toString' })).status, 400);

  // Cookie hoặc body lỗi không gây lỗi 500
  const badCookie = await fetch(`${base}/api/login`, { method: 'POST', headers: { cookie: 'x=100%' }, body: JSON.stringify({ username: 'pm', password: 'demo123' }) });
  assert.strictEqual(badCookie.status, 200);
  assert.strictEqual((await fetch(`${base}/api/login`, { method: 'POST', body: 'null' })).status, 400);

  const dash = (await pm('GET', `/api/projects/${pid}/dashboard`)).data;
  assert.strictEqual(dash.byState.WIP, 8);  // 6 mẫu + 2 container tạo trong bài kiểm tra
  const activity = (await pm('GET', `/api/projects/${pid}/activity`)).data;
  assert.ok(activity.some((a) => a.action === 'transition'));
});
