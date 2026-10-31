'use strict';
// Lưu trữ dữ liệu dạng JSON (ghi nguyên tử) + thư mục tệp. Phù hợp cho nhóm dự án nhỏ/vừa;
// có thể thay thế bằng CSDL mà không đổi lớp API.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const EMPTY = () => ({
  seq: {},
  users: [],
  sessions: {},
  projects: [],
  containers: [],
  workflows: [],
  issues: [],
  transmittals: [],
  activity: [],
});

class Store {
  constructor(dir) {
    this.dir = dir;
    this.filesDir = path.join(dir, 'files');
    this.dbFile = path.join(dir, 'db.json');
    fs.mkdirSync(this.filesDir, { recursive: true });
    this.db = fs.existsSync(this.dbFile)
      ? Object.assign(EMPTY(), JSON.parse(fs.readFileSync(this.dbFile, 'utf8')))
      : EMPTY();
    this._timer = null;
  }

  id() {
    return crypto.randomUUID();
  }

  // Số thứ tự tăng dần theo khóa (vd. số RFI trong dự án).
  nextSeq(key) {
    this.db.seq[key] = (this.db.seq[key] || 0) + 1;
    return this.db.seq[key];
  }

  save() {
    const tmp = `${this.dbFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.db, null, 1));
    fs.renameSync(tmp, this.dbFile);
  }

  filePath(storedAs) {
    return path.join(this.filesDir, path.basename(storedAs));
  }

  log(projectId, userId, action, detail) {
    this.db.activity.push({ id: this.id(), projectId, userId, action, detail, at: new Date().toISOString() });
    if (this.db.activity.length > 20000) this.db.activity.splice(0, this.db.activity.length - 20000);
  }
}

module.exports = { Store };
