'use strict';
// Quy tắc nghiệp vụ CDE theo ISO 19650-1/2 (và phụ lục quốc gia UK NA làm tham chiếu):
// đặt tên container thông tin, trạng thái, mã tình trạng (suitability), sửa đổi (revision),
// và phân quyền theo vai trò dự án.

const STATES = ['WIP', 'SHARED', 'PUBLISHED', 'ARCHIVED'];

const STATE_LABELS = {
  WIP: 'Đang thực hiện (WIP)',
  SHARED: 'Chia sẻ (Shared)',
  PUBLISHED: 'Phát hành (Published)',
  ARCHIVED: 'Lưu trữ (Archived)',
};

// Mã tình trạng hợp lệ cho từng trạng thái.
const STATUS_CODES = {
  WIP: { S0: 'Đang thực hiện' },
  SHARED: {
    S1: 'Phục vụ phối hợp',
    S2: 'Phục vụ thông tin',
    S3: 'Phục vụ xem xét & góp ý',
    S4: 'Phục vụ phê duyệt giai đoạn',
  },
  PUBLISHED: {
    A1: 'Được chấp thuận – giai đoạn 1',
    A2: 'Được chấp thuận – giai đoạn 2',
    A3: 'Được chấp thuận – giai đoạn 3',
    B1: 'Chấp thuận một phần (có ý kiến) – GĐ 1',
    B2: 'Chấp thuận một phần (có ý kiến) – GĐ 2',
    B3: 'Chấp thuận một phần (có ý kiến) – GĐ 3',
    CR: 'Hồ sơ hoàn công',
  },
  ARCHIVED: { AR: 'Lưu trữ' },
};

const TYPE_CODES = {
  M3: 'Mô hình 3D',
  M2: 'Mô hình 2D',
  CM: 'Mô hình kết hợp',
  DR: 'Bản vẽ',
  SP: 'Chỉ dẫn kỹ thuật',
  SH: 'Bảng thống kê',
  CA: 'Bảng tính',
  RP: 'Báo cáo',
  BQ: 'Bảng khối lượng',
  CR: 'Báo cáo va chạm',
  MI: 'Biên bản họp',
  CO: 'Thư từ',
  PP: 'Thuyết trình',
  SU: 'Khảo sát',
  VS: 'Diễn họa',
  IE: 'Trao đổi thông tin',
  PL: 'Kế hoạch',
  RI: 'Yêu cầu thông tin (RFI)',
};

const ROLE_CODES = {
  A: 'Kiến trúc',
  C: 'Dân dụng / Hạ tầng',
  D: 'Thoát nước',
  E: 'Điện',
  F: 'Quản lý vận hành',
  G: 'Địa kỹ thuật',
  H: 'Điều hòa thông gió',
  I: 'Nội thất',
  K: 'Chủ đầu tư',
  L: 'Cảnh quan',
  M: 'Cơ điện (MEP)',
  P: 'Cấp thoát nước',
  Q: 'Dự toán / QS',
  S: 'Kết cấu',
  T: 'Quy hoạch',
  W: 'Nhà thầu chính',
  X: 'Nhà thầu phụ',
  Y: 'Chuyên gia',
  Z: 'Tổng hợp',
};

// Vai trò thành viên trong dự án (thứ tự tăng dần quyền hạn).
const PROJECT_ROLES = {
  viewer: 'Xem',
  member: 'Thành viên nhóm',
  lead: 'Trưởng nhóm (kiểm tra)',
  manager: 'Quản lý thông tin (phê duyệt)',
};
const ROLE_RANK = { viewer: 0, member: 1, lead: 2, manager: 3 };

const FIELD_RULES = {
  project: { re: /^[A-Z0-9]{2,6}$/, label: 'Mã dự án', hint: '2–6 ký tự chữ/số' },
  originator: { re: /^[A-Z0-9]{3,6}$/, label: 'Đơn vị tạo lập', hint: '3–6 ký tự chữ/số' },
  volume: { re: /^[A-Z0-9]{1,2}$/, label: 'Khối/Hạng mục', hint: '1–2 ký tự (ZZ = tất cả, XX = không áp dụng)' },
  level: { re: /^[A-Z0-9]{2}$/, label: 'Tầng/Vị trí', hint: '2 ký tự (00, 01, B1, RF, ZZ, XX)' },
  type: { re: /^[A-Z0-9]{2}$/, label: 'Loại', hint: '2 ký tự' },
  role: { re: /^[A-Z]{1,2}$/, label: 'Bộ môn', hint: '1–2 chữ cái' },
  number: { re: /^[0-9]{4,6}$/, label: 'Số hiệu', hint: '4–6 chữ số' },
};
const FIELD_ORDER = ['project', 'originator', 'volume', 'level', 'type', 'role', 'number'];

function normalizeFields(fields) {
  const out = {};
  for (const k of FIELD_ORDER) out[k] = String((fields && fields[k]) || '').trim().toUpperCase();
  return out;
}

function validateFields(fields) {
  const errors = [];
  for (const k of FIELD_ORDER) {
    const rule = FIELD_RULES[k];
    if (!rule.re.test(fields[k] || '')) errors.push(`${rule.label} không hợp lệ (${rule.hint})`);
  }
  if (fields.type && !TYPE_CODES[fields.type]) errors.push(`Loại "${fields.type}" không có trong danh mục`);
  if (fields.role && !ROLE_CODES[fields.role]) errors.push(`Bộ môn "${fields.role}" không có trong danh mục`);
  return errors;
}

function buildName(fields) {
  return FIELD_ORDER.map((k) => fields[k]).join('-');
}

function parseName(name) {
  const parts = String(name).toUpperCase().split('-');
  if (parts.length !== FIELD_ORDER.length) return null;
  const fields = {};
  FIELD_ORDER.forEach((k, i) => (fields[k] = parts[i]));
  return validateFields(fields).length ? null : fields;
}

// --- Revision ---------------------------------------------------------------
// WIP:        P01.1, P01.2 ...  (bản làm việc)
// SHARED:     P01, P02 ...      (bản sơ bộ đã kiểm tra)
// PUBLISHED:  C01, C02 ...      (bản hợp đồng)
const REV_RE = /^([PC])(\d{2})(?:\.(\d+))?$/;

function parseRevision(rev) {
  const m = REV_RE.exec(rev || '');
  if (!m) return null;
  return { kind: m[1], major: Number(m[2]), minor: m[3] === undefined ? null : Number(m[3]) };
}

const pad2 = (n) => String(n).padStart(2, '0');

function maxMajor(revisions, kind) {
  let max = 0;
  for (const r of revisions) {
    const p = parseRevision(r);
    if (p && p.kind === kind && p.major > max) max = p.major;
  }
  return max;
}

// Revision cho một phiên bản WIP mới, dựa trên lịch sử revision của container.
function nextWipRevision(revisions) {
  const last = parseRevision(revisions[revisions.length - 1]);
  if (last && last.kind === 'P' && last.minor !== null) return `P${pad2(last.major)}.${last.minor + 1}`;
  return `P${pad2(maxMajor(revisions, 'P') + 1)}.1`;
}

function sharedRevision(revisions) {
  const last = parseRevision(revisions[revisions.length - 1]);
  if (last && last.kind === 'P' && last.minor !== null) return `P${pad2(last.major)}`;
  return `P${pad2(maxMajor(revisions, 'P') + 1)}`;
}

function publishedRevision(revisions) {
  return `C${pad2(maxMajor(revisions, 'C') + 1)}`;
}

// --- Workflow ---------------------------------------------------------------
// Chuyển trạng thái hợp lệ và vai trò tối thiểu để PHÊ DUYỆT chuyển đổi đó.
const TRANSITIONS = {
  'WIP>SHARED': { approverRole: 'lead', label: 'Kiểm tra & chia sẻ' },
  'SHARED>PUBLISHED': { approverRole: 'manager', label: 'Phê duyệt & phát hành' },
  'SHARED>WIP': { approverRole: 'member', label: 'Thu hồi để chỉnh sửa', direct: true },
  'PUBLISHED>WIP': { approverRole: 'member', label: 'Tạo sửa đổi mới', direct: true },
  'PUBLISHED>ARCHIVED': { approverRole: 'manager', label: 'Lưu trữ', direct: true },
  'SHARED>ARCHIVED': { approverRole: 'manager', label: 'Lưu trữ', direct: true },
};

function transition(from, to) {
  return TRANSITIONS[`${from}>${to}`] || null;
}

function hasRole(role, minRole) {
  return role in ROLE_RANK && ROLE_RANK[role] >= ROLE_RANK[minRole];
}

// Container WIP chỉ hiển thị cho đơn vị tạo lập và người quản lý thông tin.
function canView(member, user, container) {
  if (user.isAdmin) return true;
  if (!member) return false;
  if (container.state !== 'WIP') return true;
  return member.role === 'manager' || user.org === container.fields.originator;
}

function canEditWip(member, user, container) {
  if (user.isAdmin) return true;
  if (!member || !hasRole(member.role, 'member')) return false;
  return member.role === 'manager' || user.org === container.fields.originator;
}

module.exports = {
  STATES,
  STATE_LABELS,
  STATUS_CODES,
  TYPE_CODES,
  ROLE_CODES,
  PROJECT_ROLES,
  FIELD_RULES,
  FIELD_ORDER,
  TRANSITIONS,
  normalizeFields,
  validateFields,
  buildName,
  parseName,
  parseRevision,
  nextWipRevision,
  sharedRevision,
  publishedRevision,
  transition,
  hasRole,
  canView,
  canEditWip,
};
