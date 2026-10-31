'use strict';
const test = require('node:test');
const assert = require('node:assert');
const cde = require('../lib/cde');

test('đặt tên container theo ISO 19650', () => {
  const fields = cde.normalizeFields({ project: 'hn01', originator: 'kta', volume: 'zz', level: '01', type: 'dr', role: 'a', number: '0101' });
  assert.deepStrictEqual(cde.validateFields(fields), []);
  assert.strictEqual(cde.buildName(fields), 'HN01-KTA-ZZ-01-DR-A-0101');
  assert.deepStrictEqual(cde.parseName('HN01-KTA-ZZ-01-DR-A-0101'), fields);
  assert.strictEqual(cde.parseName('HN01-KTA-ZZ'), null);
});

test('bắt lỗi trường không hợp lệ', () => {
  const errors = cde.validateFields(cde.normalizeFields({ project: 'H', originator: 'KT', volume: 'ZZZ', level: '1', type: 'QQ', role: 'A', number: '12' }));
  assert.strictEqual(errors.length, 6);
});

test('chuỗi sửa đổi P01.1 → P01 → C01 → P02.1', () => {
  const revs = [];
  revs.push(cde.nextWipRevision(revs));
  assert.strictEqual(revs.at(-1), 'P01.1');
  revs.push(cde.nextWipRevision(revs));
  assert.strictEqual(revs.at(-1), 'P01.2');
  revs.push(cde.sharedRevision(revs));
  assert.strictEqual(revs.at(-1), 'P01');
  revs.push(cde.publishedRevision(revs));
  assert.strictEqual(revs.at(-1), 'C01');
  revs.push(cde.nextWipRevision(revs));
  assert.strictEqual(revs.at(-1), 'P02.1');
  revs.push(cde.sharedRevision(revs));
  assert.strictEqual(revs.at(-1), 'P02');
  revs.push(cde.publishedRevision(revs));
  assert.strictEqual(revs.at(-1), 'C02');
});

test('chuyển trạng thái và quyền', () => {
  assert.ok(cde.transition('WIP', 'SHARED'));
  assert.strictEqual(cde.transition('WIP', 'PUBLISHED'), null);
  assert.ok(cde.hasRole('manager', 'lead'));
  assert.ok(!cde.hasRole('member', 'lead'));
  const c = { state: 'WIP', fields: { originator: 'KTA' } };
  assert.ok(cde.canView({ role: 'member' }, { org: 'KTA' }, c));
  assert.ok(!cde.canView({ role: 'lead' }, { org: 'KCB' }, c));
  assert.ok(cde.canView({ role: 'viewer' }, { org: 'KCB' }, { ...c, state: 'SHARED' }));
  assert.ok(!cde.canEditWip({ role: 'viewer' }, { org: 'KTA' }, c));
});
