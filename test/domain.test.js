import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  parseDomain,
  validateCommitment,
  validateReceipt,
  canCommit,
  slotRemainingCapacity,
  confirmCommitment,
  expireUnconfirmed,
  handoverResponsible,
  nextActions,
  remindersFor,
  findConfidentialLeaks,
  providerQueue,
  providerOutcomes,
  fulfillmentStats,
  auditSample,
} from '../src/domain.js';

const NOW = '2027-01-20';
let DOMAIN;

test.before(async () => {
  const raw = await readFile(new URL('../fixtures/domain.json', import.meta.url), 'utf8');
  DOMAIN = parseDomain(raw);
});

const clone = () => structuredClone(DOMAIN);
const byId = (list, id) => list.find((x) => x.id === id);

test('领域元数据完整', () => {
  assert.equal(DOMAIN.domain, 'innovation-resource-commitment-fulfillment');
  assert.ok(DOMAIN.version >= 2);
  assert.ok(DOMAIN.record_types.includes('服务承诺'));
  for (const s of ['待承诺', '已承诺', '等待接受方确认', '已确认占用', '部分完成', '已核验', '已取消', '已转交', '已延期']) {
    assert.ok(DOMAIN.workflow_states.includes(s), `缺少状态：${s}`);
  }
});

test('样例整体自洽：承诺、占用、回执、容量、保密字段全部通过审计', () => {
  const audit = auditSample(DOMAIN);
  assert.deepEqual(audit.findings, []);
});

test('承诺校验：责任人不符、类型不符、期限缺失都会被拦下', () => {
  let d = clone();
  const c = byId(d.sample.commitments, 'CMT-01');
  c.responsible_user_id = 'U-LEAD-01';
  assert.deepEqual(validateCommitment(d, c).ok, false);

  d = clone();
  byId(d.sample.commitments, 'CMT-01').resource_id = 'RES-SITE-3M';
  assert.ok(validateCommitment(d, byId(d.sample.commitments, 'CMT-01')).problems.includes('时段不属于该资源'));

  d = clone();
  const bad = byId(d.sample.commitments, 'CMT-01');
  bad.slot_id = 'SLT-A-1013';
  bad.resource_id = 'RES-DD-01';
  assert.ok(validateCommitment(d, bad).problems.includes('资源类型与缺口类型不一致'));

  d = clone();
  const noDeadline = byId(d.sample.commitments, 'CMT-01');
  noDeadline.confirm_deadline = null;
  assert.ok(validateCommitment(d, noDeadline).problems.join('').includes('confirm_deadline'));
});

test('不得双重承诺：已占满的时段不能再承诺，未占满的可以', () => {
  // SLT-SITE-Q4 容量1，CMT-02 已占，CMT-07 是被拒绝的重复尝试
  assert.equal(canCommit(DOMAIN, { resource_id: 'RES-SITE-3M', slot_id: 'SLT-SITE-Q4', capacity: 1 }).ok, false);
  const rejected = byId(DOMAIN.sample.commitments, 'CMT-07');
  assert.equal(rejected.state, '已拒绝');
  assert.equal(rejected.occupancy_id, null);
  assert.ok(rejected.disposition.detail.includes('容量'));
  // 政策专场容量5，CMT-10 在0202场次占1，剩余4：申请4可承诺，申请5超卖
  assert.equal(canCommit(DOMAIN, { resource_id: 'RES-POLICY-HP', slot_id: 'SLT-POL-0202', capacity: 4 }).ok, true);
  assert.equal(canCommit(DOMAIN, { resource_id: 'RES-POLICY-HP', slot_id: 'SLT-POL-0202', capacity: 5 }).ok, false);
  // 测试线W05容量2，CMT-08 预占1（等待确认同样预占）
  const cap = slotRemainingCapacity(DOMAIN, 'RES-TEST-LINE', 'SLT-TST-W05');
  assert.deepEqual(cap, { capacity: 2, held: 1, remaining: 1 });
});

test('确认后才实际占用：逾期确认被拒，逾期未确认自动释放', () => {
  // CMT-08 确认期限 2027-01-24
  const ok = confirmCommitment(DOMAIN, 'CMT-08', '2027-01-22');
  assert.equal(ok.state, '已确认占用');
  assert.equal(ok.occupancy.units, 1);
  assert.equal(ok.occupancy.slot_id, 'SLT-TST-W05');

  assert.throws(() => confirmCommitment(DOMAIN, 'CMT-08', '2027-01-25'), /超过确认期限/);
  assert.throws(() => confirmCommitment(DOMAIN, 'CMT-01', NOW), /不可确认/);

  // 到 2027-01-25，CMT-08 若仍未确认则自动释放、容量回池
  const expired = expireUnconfirmed(DOMAIN, '2027-01-25');
  assert.equal(expired[0].commitment_id, 'CMT-08');
  assert.equal(expired[0].state, '已释放(未确认超时)');
  assert.equal(expireUnconfirmed(DOMAIN, NOW).length, 0);
});

test('取消与部分完成必须说明去向', () => {
  // RCPT-05：占用前取消，容量回池，并指向新档期
  const cancel = byId(DOMAIN.sample.receipts, 'RCPT-05');
  assert.equal(validateReceipt(DOMAIN, cancel).ok, true);
  assert.equal(cancel.disposition.type, '取消');
  assert.equal(cancel.disposition.new_slot_id, 'SLT-TST-W05');
  assert.ok(cancel.disposition.detail.includes('回池'));

  // RCPT-02：76/92 天部分完成，顺延到新时段，等待接受方确认
  const partial = byId(DOMAIN.sample.receipts, 'RCPT-02');
  assert.equal(partial.state, '部分完成');
  assert.ok(partial.delivered_units < partial.expected_units);
  assert.equal(partial.disposition.type, '延期');
  assert.equal(partial.disposition.new_slot_id, 'SLT-SITE-EXT');
  assert.equal(partial.receiver_confirmed_at, null);

  // 缺少去向说明的部分完成不合规
  const d = clone();
  const bad = byId(d.sample.receipts, 'RCPT-02');
  bad.disposition = null;
  assert.equal(validateReceipt(d, bad).ok, false);

  // 已完成但数量不足不合规
  const d2 = clone();
  const r = byId(d2.sample.receipts, 'RCPT-01');
  r.state = '已完成';
  r.delivered_units = 0;
  assert.ok(validateReceipt(d2, r).problems.join('').includes('已完成'));

  // 已核验回执必须有接受方确认
  const d3 = clone();
  const v = byId(d3.sample.receipts, 'RCPT-01');
  v.receiver_confirmed_at = null;
  assert.equal(validateReceipt(d3, v).ok, false);
});

test('责任人转交：承诺继续有效，下一对接联系人切换为继任者', () => {
  const c = byId(DOMAIN.sample.commitments, 'CMT-02');
  assert.equal(c.handover.from_user_id, 'U-PARK-01');
  assert.equal(c.handover.to_user_id, 'U-PARK-02');
  assert.ok(c.handover.reason.length > 0);

  const actions = nextActions(DOMAIN, 'PRJ-01', NOW);
  const site = actions.find((a) => a.commitment_id === 'CMT-02');
  assert.equal(site.who_user_id, 'U-PARK-02');
  assert.equal(site.who_name, '柯在');
  assert.match(site.phone, /^138/);
  assert.equal(site.by, '2027-01-22');

  // 对未占用承诺尝试转交应被拒绝
  assert.throws(
    () => handoverResponsible(DOMAIN, 'CMT-08', { to_user_id: 'U-PARK-01', at: NOW, reason: '测试' }),
    /尚未确认占用/
  );
});

test('团队打开服务即知下一次对接：按截止时间排序，含联系人电话', () => {
  const actions = nextActions(DOMAIN, 'PRJ-01', NOW);
  const ids = actions.map((a) => a.commitment_id);
  assert.deepEqual(ids, ['CMT-02', 'CMT-08']);
  for (const a of actions) {
    assert.ok(a.who_name && a.phone && a.what && a.by);
  }
  // 超期标记
  const late = nextActions(DOMAIN, 'PRJ-01', '2027-01-23');
  assert.equal(late[0].overdue, true);
});

test('保密提醒：无权限者只见代号与脱敏需求，绝不出现融资状态/机构/估值', () => {
  for (const viewerId of ['U-PARK-02', 'U-POLICY-01']) {
    const reminders = remindersFor(DOMAIN, viewerId);
    const secret = reminders.find((r) => r.confidential);
    assert.ok(secret, `${viewerId} 应有保密项目提醒`);
    assert.equal(secret.project_label, '保密项目（PRJ-02）');
    assert.equal(secret.team_name, undefined);
    const text = JSON.stringify(secret);
    for (const banned of ['A轮', '3家机构', '3.2亿', '融资', '估值']) {
      assert.ok(!text.includes(banned), `${viewerId} 的提醒泄漏了：${banned}`);
    }
  }
  // 有权限的项目负责人可见真实名称
  const lead = remindersFor(DOMAIN, 'U-LEAD-02');
  assert.ok(lead.some((r) => r.project_label === '固态电池中试项目'));
  // 静态扫描：样例回执与成果中无保密字段泄漏
  assert.deepEqual(findConfidentialLeaks(DOMAIN), []);

  // 注入泄漏文本必须被发现
  const d = clone();
  d.sample.outcomes[0].summary = '该项目正在洽谈A轮估值3.2亿';
  assert.ok(findConfidentialLeaks(d).length >= 1);
});

test('提供方可看待办与资源是否产生结果', () => {
  // 高松：等接受方确认 CMT-08
  const gao = providerQueue(DOMAIN, 'U-IND-01');
  assert.ok(gao.some((x) => x.commitment_id === 'CMT-08' && x.type === '等待接受方确认承诺'));
  // 柯在（转交继任者）：RCPT-02 等待核验
  const ke = providerQueue(DOMAIN, 'U-PARK-02');
  assert.ok(ke.some((x) => x.receipt_id === 'RCPT-02'));

  const mentor = providerOutcomes(DOMAIN, 'U-MENTOR-A');
  const cmt01 = mentor.find((x) => x.commitment_id === 'CMT-01');
  assert.equal(cmt01.produced_outcome, true);
  assert.equal(cmt01.outcomes[0].kind, '验证完成');
  // 测试线承诺尚无已核验成果（尽调/测试尚未产出）
  const ind = providerOutcomes(DOMAIN, 'U-IND-01');
  assert.ok(ind.every((x) => x.produced_outcome === false));
});

test('平台统计已完成的试制/验证/合作，而不是名片或对接次数', () => {
  const stats = fulfillmentStats(DOMAIN);
  assert.equal(stats.已核验成果总数, 4);
  assert.deepEqual(stats.兑现成果, { 试制完成: 1, 验证完成: 2, 合作达成: 1 });
  // OUT-03 未挂接平台承诺且未核验 → 不计入
  assert.ok(stats.未计入.some((x) => x.id === 'OUT-03'));
  assert.ok(stats.说明.includes('名片'));
  // 元数据中不存在"名片交换"类指标
  const keys = Object.keys(stats);
  assert.ok(!keys.some((k) => k.includes('名片') || k.includes('对接次数')));
});
