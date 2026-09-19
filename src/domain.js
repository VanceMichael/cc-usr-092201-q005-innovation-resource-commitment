// 读取并检查项目共享的领域资料。
export function parseDomain(raw) {
  const value = JSON.parse(raw);
  const complete = value.domain && value.version >= 1 && value.sample_id && Array.isArray(value.record_types) && value.record_types.length >= 3 && Array.isArray(value.workflow_states) && value.workflow_states.length >= 3 && Array.isArray(value.facts) && value.facts.length >= 2 && value.sample;
  if (!complete) throw new Error('领域资料缺少必要内容');
  return value;
}
