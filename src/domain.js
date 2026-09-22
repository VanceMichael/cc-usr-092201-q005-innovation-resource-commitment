// 科创资源承诺兑现：领域规则（纯函数，无外部依赖）。
//
// 核心约定：
// 1. 项目先声明阶段与具体缺口；提供方针对资源目录中的时段作出承诺。
// 2. 承诺带责任人、容量、答复期限与确认期限；作出即预占容量，接受方确认后实际占用。
// 3. 同一提供方同一时段容量不得超卖；逾期未确认自动释放。
// 4. 取消/转交/延期/部分完成必须带 disposition（去向说明）。
// 5. 履约回执由提供方登记、接受方核验；转化结果须挂接承诺且核验后才计入统计。
// 6. 保密项目的保密字段（融资状态等）不得出现在面向无保密权限人员的提醒与记录中。

const ACTIVE_STATES = ['已承诺', '等待接受方确认', '已确认占用', '履约中', '部分完成', '已完成'];
const OCCUPYING_STATES = ['已承诺', '等待接受方确认', '已确认占用', '履约中', '部分完成', '已完成', '已核验'];
const TERMINAL_STATES = ['已核验', '已取消', '已拒绝', '已释放(未确认超时)'];
const DISPOSITION_REQUIRED_STATES = ['部分完成', '已取消', '已延期', '已转交'];

export class DomainError extends Error {}

// 读取并检查项目共享的领域资料（兼容 v1 元数据与 v2 完整样例）。
export function parseDomain(raw) {
  const value = typeof raw === 'string' ? JSON.parse(raw) : raw;
  const required = ['domain', 'version', 'sample_id', 'record_types', 'workflow_states', 'facts'];
  for (const key of required) {
    if (value[key] === undefined || value[key] === null) throw new DomainError(`领域资料缺少必要内容：${key}`);
  }
  if (!Number.isInteger(value.version) || value.version < 1) throw new DomainError('领域资料版本无效');
  if (!Array.isArray(value.record_types) || value.record_types.length < 3) throw new DomainError('记录类型不足');
  if (!Array.isArray(value.workflow_states) || value.workflow_states.length < 3) throw new DomainError('流程状态不足');
  if (!Array.isArray(value.facts) || value.facts.length < 2) throw new DomainError('业务事实不足');
  if (value.version >= 2 && (!value.sample || typeof value.sample !== 'object')) throw new DomainError('v2 资料缺少 sample 记录');
  return value;
}

export function index(domain) {
  const s = domain.sample || {};
  const byId = (list) => new Map((list || []).map((x) => [x.id, x]));
  return {
    projects: byId(s.projects),
    users: byId(s.users),
    gaps: byId(s.gaps),
    resources: byId(s.resources),
    commitments: byId(s.commitments),
    occupancies: byId(s.occupancies),
    receipts: byId(s.receipts),
    outcomes: byId(s.outcomes),
  };
}

const day = (d) => (d ? d.slice(0, 10) : null);

// 单条承诺的形式校验：主体存在、类型匹配、责任人属于提供方、容量与期限齐全。
export function validateCommitment(domain, c) {
  const idx = index(domain);
  const problems = [];
  const project = idx.projects.get(c.project_id);
  const gap = idx.gaps.get(c.gap_id);
  const resource = idx.resources.get(c.resource_id);
  const owner = idx.users.get(c.responsible_user_id);
  if (!project) problems.push('项目不存在');
  if (!gap) problems.push('缺口不存在');
  if (!resource) problems.push('资源不存在');
  if (gap && gap.project_id !== c.project_id) problems.push('缺口不属于该项目');
  if (gap && resource && gap.type !== resource.type) problems.push('资源类型与缺口类型不一致');
  if (resource && !resource.slots.some((s) => s.slot_id === c.slot_id)) problems.push('时段不属于该资源');
  if (!owner) problems.push('责任人不存在');
  if (resource && owner && !owner.organization?.startsWith(resource.provider_org.slice(0, 6)) && owner.id !== resource.owner_id) {
    // 组织名允许简写/全称差异，但责任人必须是资源登记责任人或其后任（handover 链）。
    const successors = (domain.sample.commitments || [])
      .filter((x) => x.resource_id === c.resource_id && x.handover?.to_user_id === owner.id);
    if (owner.id !== resource.owner_id && successors.length === 0) problems.push('责任人不属于提供方且无转交记录');
  }
  if (!Number.isInteger(c.capacity) || c.capacity < 1) problems.push('承诺容量必须为正整数');
  for (const k of ['made_at', 'commit_reply_by', 'confirm_deadline']) {
    if (!c[k]) problems.push(`缺少期限：${k}`);
  }
  if (c.made_at && c.commit_reply_by && c.made_at > c.commit_reply_by) problems.push('承诺作出晚于答复期限');
  if (c.made_at && c.confirm_deadline && c.confirm_deadline < c.made_at) problems.push('确认期限早于承诺作出日');
  return { ok: problems.length === 0, problems };
}

// 计算某资源时段的剩余容量。作出承诺即预占（含等待确认），取消/拒绝/释放不占。
export function slotRemainingCapacity(domain, resourceId, slotId, opts = {}) {
  const idx = index(domain);
  const resource = idx.resources.get(resourceId);
  if (!resource) throw new DomainError('资源不存在');
  const slot = resource.slots.find((s) => s.slot_id === slotId);
  if (!slot) throw new DomainError('时段不存在');
  const held = (domain.sample.commitments || [])
    .filter((c) => c.resource_id === resourceId && c.slot_id === slotId)
    .filter((c) => c.id !== opts.excludeCommitmentId)
    .filter((c) => OCCUPYING_STATES.includes(c.state))
    .reduce((sum, c) => sum + (c.capacity || 0), 0);
  return { capacity: slot.capacity, held, remaining: slot.capacity - held };
}

// 提供方能否就该时段作出承诺：不得把同一时段重复承诺给多个项目。
export function canCommit(domain, candidate) {
  const { resource_id: resourceId, slot_id: slotId, capacity = 1 } = candidate;
  const { remaining } = slotRemainingCapacity(domain, resourceId, slotId, {
    excludeCommitmentId: candidate.excludeCommitmentId,
  });
  if (remaining < capacity) {
    return { ok: false, reason: `同一提供方同一时段剩余容量不足（剩余${remaining}，申请${capacity}），不得重复承诺` };
  }
  return { ok: true };
}

// 接受方确认承诺：必须在确认期限内，且容量仍在。返回确认后的状态与占用记录。
export function confirmCommitment(domain, commitmentId, confirmedAt) {
  const idx = index(domain);
  const c = idx.commitments.get(commitmentId);
  if (!c) throw new DomainError('承诺不存在');
  if (!['已承诺', '等待接受方确认'].includes(c.state)) throw new DomainError('当前状态不可确认');
  if (day(confirmedAt) > c.confirm_deadline) throw new DomainError('已超过确认期限，承诺应自动释放而非确认');
  const cap = canCommit(domain, { resource_id: c.resource_id, slot_id: c.slot_id, capacity: c.capacity, excludeCommitmentId: c.id });
  if (!cap.ok) throw new DomainError(cap.reason);
  const occupancy = {
    id: `OCC-NEW-${commitmentId}`,
    commitment_id: commitmentId,
    resource_id: c.resource_id,
    slot_id: c.slot_id,
    project_id: c.project_id,
    units: c.capacity,
    from: confirmedAt,
  };
  return { state: '已确认占用', receiver_confirmed_at: day(confirmedAt), occupancy };
}

// 到某时点仍未确认的承诺：自动失效、容量回池。
export function expireUnconfirmed(domain, now) {
  const today = day(now);
  return (domain.sample.commitments || [])
    .filter((c) => ['已承诺', '等待接受方确认'].includes(c.state))
    .filter((c) => c.confirm_deadline < today)
    .map((c) => ({
      commitment_id: c.id,
      state: '已释放(未确认超时)',
      released_at: today,
      release_reason: `接受方未在${c.confirm_deadline}前确认，容量自动回池`,
    }));
}

// 登记履约回执：数量关系与去向说明必须自洽。
export function validateReceipt(domain, r) {
  const idx = index(domain);
  const problems = [];
  const c = idx.commitments.get(r.commitment_id);
  if (!c) {
    problems.push('承诺不存在');
    return { ok: false, problems };
  }
  if (r.delivered_units > r.expected_units) problems.push('交付数量不能超过承诺数量');
  if (r.state === '已完成' && r.delivered_units !== r.expected_units) problems.push('已完成要求交付数量等于承诺数量，部分交付应记为部分完成');
  if (r.state === '部分完成' && r.delivered_units >= r.expected_units) problems.push('部分完成要求交付数量小于承诺数量');
  if (['部分完成', '已取消', '已延期'].includes(r.state) || DISPOSITION_REQUIRED_STATES.includes(r.state)) {
    if (!r.disposition || !r.disposition.type || !r.disposition.detail || !r.disposition.reported_at) {
      problems.push('取消/转交/延期/部分完成必须登记去向类型、说明与登记时间');
    }
  }
  if (r.state === '已延期' && r.disposition && !r.disposition.new_slot_id) problems.push('延期必须指明新时段');
  if (r.state === '已取消' && c.occupancy_id && !(r.disposition && r.disposition.released_capacity_to)) {
    problems.push('已占用后取消必须说明容量释放去向');
  }
  if (r.state === '已核验' && r.delivered_units !== r.expected_units) problems.push('已核验要求足额交付，不足额应停留在部分完成并登记去向');
  if (r.state === '已核验' && !r.receiver_confirmed_at) problems.push('已核验回执必须有接受方确认时间');
  return { ok: problems.length === 0, problems };
}

// 转交责任人：记录前后任、原因、接受方知悉时间；承诺继续有效，联系人切换。
export function handoverResponsible(domain, commitmentId, { to_user_id, at, reason }) {
  const idx = index(domain);
  const c = idx.commitments.get(commitmentId);
  if (!c) throw new DomainError('承诺不存在');
  if (!idx.users.get(to_user_id)) throw new DomainError('继任责任人不存在');
  if (!c.occupancy_id) throw new DomainError('尚未确认占用的承诺无需转交，可直接取消后重提');
  return {
    commitment_id: commitmentId,
    state: '履约中',
    responsible_user_id: to_user_id,
    handover: { from_user_id: c.responsible_user_id, to_user_id, at, reason, acknowledged_by_receiver_at: null },
  };
}

// 团队视角：下一次对接找谁。按截止时间升序，解析转交后的现任责任人。
export function nextActions(domain, projectId, now) {
  const idx = index(domain);
  const today = day(now);
  const items = [];
  for (const c of (domain.sample.commitments || []).filter((x) => x.project_id === projectId)) {
    if (!c.next_action) continue;
    if (TERMINAL_STATES.includes(c.state) && !(c.next_action.by && c.next_action.by >= today)) continue;
    const currentUserId = c.handover?.to_user_id || c.responsible_user_id;
    const contact = idx.users.get(currentUserId);
    const overdue = c.next_action.by && c.next_action.by < today;
    items.push({
      commitment_id: c.id,
      resource_type: idx.resources.get(c.resource_id)?.type,
      state: c.state,
      who_user_id: currentUserId,
      who_name: contact?.name,
      who_org: contact?.organization,
      phone: contact?.phone,
      what: c.next_action.what,
      by: c.next_action.by,
      overdue,
    });
  }
  return items.sort((a, b) => (a.by || '9999').localeCompare(b.by || '9999'));
}

// 面向具体查看者的提醒：保密项目对无保密权限者只显示代号，绝不带融资状态等字段。
export function remindersFor(domain, viewer) {
  const idx = index(domain);
  const viewerRecord = typeof viewer === 'string' ? idx.users.get(viewer) : viewer;
  if (!viewerRecord) throw new DomainError('查看者不存在');
  const redacted = [];
  for (const c of (domain.sample.commitments || [])) {
    if (c.state === '已拒绝' || c.state === '已取消' || c.state === '已释放(未确认超时)') continue;
    if (!c.next_action) continue;
    const project = idx.projects.get(c.project_id);
    if (!project) continue;
    const assignedToThem = c.next_action?.who === viewerRecord.id || c.responsible_user_id === viewerRecord.id
      || c.handover?.to_user_id === viewerRecord.id || project.contact_user_id === viewerRecord.id;
    if (!assignedToThem) continue;
    const resource = idx.resources.get(c.resource_id);
    const gap = idx.gaps.get(c.gap_id);
    const base = {
      commitment_id: c.id,
      resource_type: resource.type,
      what: c.next_action?.what,
      by: c.next_action?.by,
    };
    if (project.confidential && !viewerRecord.confidential_view) {
      redacted.push({
        ...base,
        project_label: `保密项目（${project.id}）`,
        team_name: undefined,
        need: gap.description,
        confidential: true,
        notice: '该项目为保密项目，提醒仅显示代号与必要需求，其他敏感信息已按查看者权限隐藏',
      });
    } else {
      redacted.push({ ...base, project_label: project.name, team_name: project.team_name, confidential: project.confidential });
    }
  }
  return redacted;
}

// 静态防泄漏：保密字段值不得出现在任何回执/结果文本中。
export function findConfidentialLeaks(domain) {
  const idx = index(domain);
  const leaks = [];
  const secretValues = [];
  for (const [pid, project] of idx.projects) {
    if (!project.confidential) continue;
    for (const g of (domain.sample.gaps || []).filter((x) => x.project_id === pid)) {
      for (const f of project.confidential_fields || []) {
        if (g[f]) secretValues.push({ project_id: pid, field: f, value: g[f] });
      }
    }
  }
  const corpus = [];
  for (const listName of ['receipts', 'outcomes']) {
    for (const item of domain.sample[listName] || []) {
      corpus.push({ list: listName, id: item.id, text: `${item.title || ''} ${item.summary || ''}` });
    }
  }
  for (const secret of secretValues) {
    for (const piece of secret.value.split(/[（）()，、；;\s]+/).filter((x) => x.length >= 3)) {
      for (const doc of corpus) {
        if (doc.text.includes(piece)) leaks.push({ ...secret, found_in: `${doc.list}:${doc.id}`, matched: piece });
      }
    }
  }
  return leaks;
}

// 提供方视角：需要我处理的事——等接受方确认的承诺、等接受方核验的回执。
export function providerQueue(domain, userId) {
  const idx = index(domain);
  const waitingAccept = (domain.sample.commitments || [])
    .filter((c) => (c.responsible_user_id === userId || c.handover?.to_user_id === userId))
    .filter((c) => c.state === '等待接受方确认' || c.state === '已承诺')
    .map((c) => ({ type: '等待接受方确认承诺', commitment_id: c.id, project_id: c.project_id, deadline: c.confirm_deadline }));
  const waitingVerify = (domain.sample.receipts || [])
    .filter((r) => r.provider_reported_at && !r.receiver_confirmed_at)
    .filter((r) => {
      const c = idx.commitments.get(r.commitment_id);
      if (!c) return false;
      const currentResponsible = c.handover?.to_user_id || c.responsible_user_id;
      return currentResponsible === userId;
    })
    .map((r) => ({ type: '等待接受方核验结果', receipt_id: r.id, commitment_id: r.commitment_id, project_id: r.project_id, state: r.state }));
  return [...waitingAccept, ...waitingVerify];
}

// 提供方视角：我的资源最终产生了哪些已核验成果（区分"已履约但尚无成果"）。
export function providerOutcomes(domain, userId) {
  const idx = index(domain);
  const mine = (domain.sample.commitments || [])
    .filter((c) => (c.handover?.to_user_id || c.responsible_user_id) === userId);
  return mine.map((c) => {
    const outcomes = (domain.sample.outcomes || []).filter((o) => (o.commitment_ids || []).includes(c.id) && o.verified);
    return {
      commitment_id: c.id,
      project_id: c.project_id,
      resource_id: c.resource_id,
      state: c.state,
      produced_outcome: outcomes.length > 0,
      outcomes: outcomes.map((o) => ({ id: o.id, kind: o.kind, title: o.title })),
    };
  });
}

// 平台统计：只算已核验、且挂接了平台承诺的试制/验证/合作成果，不算名片与对接次数。
export function fulfillmentStats(domain) {
  const idx = index(domain);
  const byKind = {};
  const unverified = [];
  for (const o of domain.sample.outcomes || []) {
    if (!o.verified || (o.commitment_ids || []).length === 0) {
      unverified.push({ id: o.id, reason: !o.verified ? '未核验' : '未挂接平台承诺，无法归因' });
      continue;
    }
    const missing = o.commitment_ids.filter((id) => !idx.commitments.has(id));
    if (missing.length) {
      unverified.push({ id: o.id, reason: `挂接的承诺不存在：${missing.join(',')}` });
      continue;
    }
    byKind[o.kind] = (byKind[o.kind] || 0) + 1;
  }
  const offered = (domain.sample.commitments || []).length;
  const fulfilled = (domain.sample.commitments || []).filter((c) => ['已完成', '已核验', '部分完成'].includes(c.state)).length;
  return {
    兑现成果: byKind,
    已核验成果总数: Object.values(byKind).reduce((a, b) => a + b, 0),
    承诺数: offered,
    进入履约数: fulfilled,
    未计入: unverified,
    说明: '名片交换数、路演到场数不作为兑现指标',
  };
}

// 样例整体自洽审计，供测试与后续服务回归使用。
export function auditSample(domain) {
  const findings = [];
  const idx = index(domain);
  for (const c of domain.sample.commitments || []) {
    const v = validateCommitment(domain, c);
    if (!v.ok) findings.push({ commitment_id: c.id, problems: v.problems });
    const confirmed = c.receiver_confirmed_at != null;
    if (confirmed && !c.occupancy_id && !['已取消', '已转交'].includes(c.state)) findings.push({ commitment_id: c.id, problems: ['已确认但缺少容量占用记录'] });
    if (!confirmed && c.occupancy_id) findings.push({ commitment_id: c.id, problems: ['未确认却存在容量占用记录'] });
    if (c.occupancy_id) {
      const occ = idx.occupancies.get(c.occupancy_id);
      if (!occ) findings.push({ commitment_id: c.id, problems: ['占用记录不存在'] });
      if (occ && (occ.resource_id !== c.resource_id || occ.slot_id !== c.slot_id)) findings.push({ commitment_id: c.id, problems: ['占用记录与承诺时段不一致'] });
    }
  }
  for (const r of domain.sample.receipts || []) {
    const v = validateReceipt(domain, r);
    if (!v.ok) findings.push({ receipt_id: r.id, problems: v.problems });
  }
  // 双重承诺核查：占用态承诺总量不得超过任一时段容量（被拒绝的尝试不计入）。
  for (const resource of domain.sample.resources || []) {
    for (const slot of resource.slots) {
      const { held, capacity } = slotRemainingCapacity(domain, resource.id, slot.slot_id);
      if (held > capacity) findings.push({ slot_id: slot.slot_id, problems: [`容量超卖：占用${held}，容量${capacity}`] });
    }
  }
  for (const leak of findConfidentialLeaks(domain)) findings.push({ leaks: leak });
  return { ok: findings.length === 0, findings };
}
