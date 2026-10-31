'use strict';
// Dữ liệu mẫu: một dự án, ba đơn vị (chủ đầu tư, tư vấn kiến trúc, tư vấn kết cấu).

function seedDemo(store, hashPassword) {
  const db = store.db;
  if (db.projects.length) return;
  const at = new Date().toISOString();
  const mk = (username, name, org) => {
    const u = { id: store.id(), username, name, email: `${username}@example.com`, org, isAdmin: false, ...hashPassword('demo123'), createdAt: at };
    db.users.push(u);
    return u;
  };
  const pm = mk('pm', 'Nguyễn Văn Quản', 'CDT');
  const arcLead = mk('kt.lead', 'Trần Thị Kiến', 'KTA');
  const arc = mk('kt', 'Lê Văn Trúc', 'KTA');
  const strLead = mk('kc.lead', 'Phạm Văn Cấu', 'KCB');
  const viewer = mk('xem', 'Hoàng Thị Xem', 'GSA');

  const project = {
    id: store.id(),
    code: 'HN01',
    name: 'Tòa nhà văn phòng Hà Nội 01',
    client: 'Công ty CP Đầu tư Mẫu',
    location: 'Cầu Giấy, Hà Nội',
    stage: 'Thiết kế kỹ thuật',
    description: 'Dự án mẫu để trải nghiệm quy trình CDE theo ISO 19650.',
    createdAt: at,
    members: [
      { userId: pm.id, role: 'manager' },
      { userId: arcLead.id, role: 'lead' },
      { userId: arc.id, role: 'member' },
      { userId: strLead.id, role: 'lead' },
      { userId: viewer.id, role: 'viewer' },
    ],
  };
  db.projects.push(project);

  const containers = [
    ['KTA', 'ZZ', 'ZZ', 'M3', 'A', '0001', 'Mô hình kiến trúc tổng thể'],
    ['KTA', 'ZZ', '01', 'DR', 'A', '0101', 'Mặt bằng tầng 1'],
    ['KTA', 'ZZ', '02', 'DR', 'A', '0102', 'Mặt bằng tầng 2'],
    ['KCB', 'ZZ', 'ZZ', 'M3', 'S', '0001', 'Mô hình kết cấu tổng thể'],
    ['KCB', 'ZZ', 'ZZ', 'CA', 'S', '0001', 'Thuyết minh tính toán kết cấu'],
    ['CDT', 'ZZ', 'ZZ', 'PL', 'K', '0001', 'Kế hoạch thực hiện BIM (BEP)'],
  ];
  for (const [originator, volume, level, type, role, number, title] of containers) {
    const fields = { project: project.code, originator, volume, level, type, role, number };
    const owner = { KTA: arc, KCB: strLead, CDT: pm }[originator];
    db.containers.push({
      id: store.id(),
      projectId: project.id,
      name: Object.values(fields).join('-'),
      fields,
      title,
      description: '',
      state: 'WIP',
      statusCode: 'S0',
      versions: [],
      createdBy: owner.id,
      createdAt: at,
      updatedAt: at,
    });
  }
  store.log(project.id, pm.id, 'project.create', `Tạo dự án mẫu ${project.code}`);
  store.save();
  console.log('Đã tạo dữ liệu mẫu. Tài khoản (mật khẩu demo123): pm, kt.lead, kt, kc.lead, xem');
}

module.exports = { seedDemo };
