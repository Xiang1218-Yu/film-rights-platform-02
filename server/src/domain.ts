import { randomUUID } from 'node:crypto';

export type ProjectStatus = 'development' | 'production' | 'post' | 'delivered';
export type AssetType = 'master' | 'trailer' | 'poster' | 'audio' | 'subtitle';
export type ApprovalStatus = 'pending' | 'approved' | 'rejected';

export interface Project { id: string; code: string; title: string; season: number; status: ProjectStatus; currency: string; budgetVersionId: string; deliveryDate: string; }
export interface BudgetLine { id: string; projectId: string; category: string; subcategory: string; planned: number; committed: number; actual: number; forecast: number; owner: string; risk: 'low' | 'medium' | 'high'; }
export interface Contract { id: string; projectId: string; vendor: string; scope: string; ceiling: number; committed: number; paid: number; milestones: { name: string; due: string; amount: number; status: 'open' | 'invoiced' | 'paid' }[]; }
export interface Asset { id: string; projectId: string; name: string; type: AssetType; version: number; status: 'draft' | 'review' | 'approved' | 'locked'; owner: string; checksum: string; territories: string[]; platforms: string[]; availableFrom: string; availableTo: string; rightsTags: string[]; }
export interface Approval { id: string; projectId: string; entityType: 'budget' | 'asset' | 'delivery'; entityId: string; title: string; requestedBy: string; status: ApprovalStatus; approver: string; createdAt: string; comment?: string; }
export interface AuditEvent { id: string; action: string; entity: string; entityId: string; actor: string; at: string; details: string; }

// 同一毫秒内的并发调用会共享 Date.now()，因此再叠加进程内自增序列与随机段，
// 保证审批、审计等所有资源标识在进程生命周期内稳定且唯一。
let idSequence = 0;
export function uniqueId(prefix: string): string {
  idSequence += 1;
  return `${prefix}-${Date.now().toString(36)}-${idSequence.toString(36)}-${randomUUID().slice(0, 8)}`;
}

// 业务冲突（如审批已被他人处理）与幂等键冲突，HTTP 层据此映射为 409。
export class ValidationError extends Error { code = 'VALIDATION_ERROR' as const; }
export class ApprovalConflictError extends Error {
  code = 'APPROVAL_CONFLICT' as const;
  constructor(message: string, readonly current: Approval) { super(message); }
}
export class IdempotencyConflictError extends Error { code = 'IDEMPOTENCY_CONFLICT' as const; }

export interface CreateApprovalInput extends Pick<Approval, 'projectId' | 'entityType' | 'entityId' | 'title' | 'requestedBy' | 'approver'> {}
export interface MutationResult<T> { value: T; replayed: boolean }

const now = Date.now();
const iso = (days: number) => new Date(now + days * 86400000).toISOString().slice(0, 10);

export const projects: Project[] = [
  { id: 'PRJ-001', code: 'NORTHSTAR-S1', title: 'Northstar / 北境回声', season: 1, status: 'post', currency: 'CNY', budgetVersionId: 'BUD-001-V3', deliveryDate: iso(44) },
  { id: 'PRJ-002', code: 'ORBIT-DOC', title: 'Orbit / 轨道之外', season: 1, status: 'production', currency: 'CNY', budgetVersionId: 'BUD-002-V2', deliveryDate: iso(126) }
];
export const budgetLines: BudgetLine[] = [
  { id: 'BL-101', projectId: 'PRJ-001', category: '制作', subcategory: '主演与主创', planned: 12800000, committed: 11200000, actual: 10400000, forecast: 13100000, owner: '制片部', risk: 'medium' },
  { id: 'BL-102', projectId: 'PRJ-001', category: '制作', subcategory: '摄影器材与场地', planned: 6800000, committed: 6400000, actual: 5980000, forecast: 7020000, owner: '现场制片', risk: 'low' },
  { id: 'BL-103', projectId: 'PRJ-001', category: '后期', subcategory: '调色、DIT、母版', planned: 5400000, committed: 4300000, actual: 2800000, forecast: 5750000, owner: '后期制片', risk: 'high' },
  { id: 'BL-104', projectId: 'PRJ-001', category: '宣发', subcategory: '预告片与物料', planned: 3600000, committed: 1900000, actual: 1240000, forecast: 3200000, owner: '营销部', risk: 'medium' },
  { id: 'BL-201', projectId: 'PRJ-002', category: '制作', subcategory: '跨国拍摄', planned: 9200000, committed: 5100000, actual: 3300000, forecast: 9000000, owner: '制片部', risk: 'medium' }
];
export const contracts: Contract[] = [
  { id: 'CTR-01', projectId: 'PRJ-001', vendor: '曜石后期制作', scope: '4K HDR 调色、声音、DCP 母版', ceiling: 5200000, committed: 4300000, paid: 2300000, milestones: [{ name: '锁剪交付', due: iso(8), amount: 1200000, status: 'invoiced' }, { name: '母版验收', due: iso(36), amount: 2000000, status: 'open' }] },
  { id: 'CTR-02', projectId: 'PRJ-001', vendor: '远景国际版权', scope: '北美与欧洲音乐同步许可', ceiling: 880000, committed: 880000, paid: 440000, milestones: [{ name: '签署', due: iso(-16), amount: 440000, status: 'paid' }, { name: '交付版权证明', due: iso(4), amount: 440000, status: 'invoiced' }] },
  { id: 'CTR-03', projectId: 'PRJ-002', vendor: '云帧视觉', scope: '纪录片航拍与卫星素材', ceiling: 1600000, committed: 1100000, paid: 600000, milestones: [{ name: '素材包一', due: iso(20), amount: 500000, status: 'open' }] }
];
export const assets: Asset[] = [
  { id: 'AST-001', projectId: 'PRJ-001', name: '北境回声 S01E01 4K HDR Master', type: 'master', version: 7, status: 'review', owner: '后期制片', checksum: 'sha256:91b7…e2a1', territories: ['CN', 'HK', 'SG'], platforms: ['影院', 'StreamBox'], availableFrom: iso(-2), availableTo: iso(730), rightsTags: ['音乐-同步许可', '演员-全媒介'] },
  { id: 'AST-002', projectId: 'PRJ-001', name: '主预告 90s / Cut A', type: 'trailer', version: 4, status: 'approved', owner: '营销部', checksum: 'sha256:42ca…9b02', territories: ['CN'], platforms: ['StreamBox', '短视频'], availableFrom: iso(6), availableTo: iso(180), rightsTags: ['演员-宣传许可'] },
  { id: 'AST-003', projectId: 'PRJ-001', name: '片尾曲 / Winter Signal', type: 'audio', version: 2, status: 'locked', owner: '音乐版权', checksum: 'sha256:113c…78f0', territories: ['CN', 'US', 'CA'], platforms: ['影院', 'StreamBox'], availableFrom: iso(-40), availableTo: iso(52), rightsTags: ['音乐-同步许可'] },
  { id: 'AST-004', projectId: 'PRJ-002', name: 'Orbit E02 Satellite Plates', type: 'master', version: 3, status: 'review', owner: '视觉总监', checksum: 'sha256:8a10…4a9d', territories: ['全球'], platforms: ['影院'], availableFrom: iso(18), availableTo: iso(365), rightsTags: ['航拍-编辑许可'] }
];
export const approvals: Approval[] = [
  { id: 'APR-01', projectId: 'PRJ-001', entityType: 'budget', entityId: 'BUD-001-V3', title: '后期超支预案 V3', requestedBy: '制片主任', status: 'pending', approver: '财务负责人', createdAt: iso(-1) },
  { id: 'APR-02', projectId: 'PRJ-001', entityType: 'asset', entityId: 'AST-001', title: 'E01 最终母版锁定', requestedBy: '后期制片', status: 'pending', approver: '总制片人', createdAt: iso(-2) },
  { id: 'APR-03', projectId: 'PRJ-002', entityType: 'delivery', entityId: 'DEL-007', title: '海外节展交付包', requestedBy: '发行部', status: 'approved', approver: '法务负责人', createdAt: iso(-5), comment: '已补充航拍授权凭证' }
];
export const auditEvents: AuditEvent[] = [{ id: 'AUD-01', action: 'CREATE', entity: 'budget', entityId: 'BUD-001-V3', actor: '制片主任', at: new Date(now - 86400000).toISOString(), details: '从 V2 复制并调整后期科目' }];

// Idempotency-Key → 首次请求的内容指纹与结果。网络重试或双击重放时直接返回首次结果，
// 不产生幽灵审批记录；同一键携带不同内容则明确拒绝。
interface IdempotentCreateRecord { fingerprint: string; approval: Approval }
const idempotentCreates = new Map<string, IdempotentCreateRecord>();

function approvalFingerprint(input: CreateApprovalInput): string {
  return JSON.stringify([input.projectId, input.entityType, input.entityId, input.title, input.requestedBy, input.approver]);
}

export function projectSummary(projectId = projects[0].id) {
  const lines = budgetLines.filter(line => line.projectId === projectId);
  const projectContracts = contracts.filter(contract => contract.projectId === projectId);
  const projectAssets = assets.filter(asset => asset.projectId === projectId);
  const projectApprovals = approvals.filter(approval => approval.projectId === projectId);
  const planned = lines.reduce((sum, line) => sum + line.planned, 0);
  const forecast = lines.reduce((sum, line) => sum + line.forecast, 0);
  const actual = lines.reduce((sum, line) => sum + line.actual, 0);
  return { project: projects.find(project => project.id === projectId), planned, forecast, actual, variance: forecast - planned, utilization: planned ? actual / planned : 0, committed: lines.reduce((sum, line) => sum + line.committed, 0), contractExposure: projectContracts.reduce((sum, contract) => sum + contract.ceiling, 0), assetCount: projectAssets.length, pendingApprovals: projectApprovals.filter(item => item.status === 'pending').length, highRiskLines: lines.filter(line => line.risk === 'high'), lines, contracts: projectContracts, assets: projectAssets, approvals: projectApprovals };
}

export function rightsConflicts(projectId = projects[0].id) {
  const list = assets.filter(asset => asset.projectId === projectId);
  const conflicts: { severity: 'critical' | 'warning'; assetA: string; assetB: string; reason: string }[] = [];
  for (let i = 0; i < list.length; i += 1) for (let j = i + 1; j < list.length; j += 1) {
    const a = list[i], b = list[j];
    const sameTag = a.rightsTags.some(tag => b.rightsTags.includes(tag));
    const sameTerritory = a.territories.includes('全球') || b.territories.includes('全球') || a.territories.some(territory => b.territories.includes(territory));
    if (sameTag && sameTerritory && a.availableTo >= b.availableFrom && b.availableTo >= a.availableFrom) conflicts.push({ severity: a.status === 'locked' || b.status === 'locked' ? 'critical' : 'warning', assetA: a.name, assetB: b.name, reason: `同一授权标签在重叠窗口内覆盖相同地域：${a.rightsTags.filter(tag => b.rightsTags.includes(tag)).join('、')}` });
  }
  return conflicts;
}

export function createApproval(input: CreateApprovalInput, idempotencyKey?: string): MutationResult<Approval> {
  for (const field of ['projectId', 'entityType', 'entityId', 'title', 'requestedBy', 'approver'] as const) {
    if (typeof input[field] !== 'string' || input[field].trim() === '') throw new ValidationError(`字段 ${field} 不能为空`);
  }
  if (input.entityType !== 'budget' && input.entityType !== 'asset' && input.entityType !== 'delivery') throw new ValidationError('entityType 必须是 budget / asset / delivery');

  const fingerprint = approvalFingerprint(input);
  if (idempotencyKey) {
    const seen = idempotentCreates.get(idempotencyKey);
    if (seen) {
      if (seen.fingerprint !== fingerprint) throw new IdempotencyConflictError('相同幂等键对应了不同的审批内容，已拒绝');
      return { value: seen.approval, replayed: true };
    }
  }

  // 业务级去重：两个角色从不同浏览器（或不同幂等键）为同一实体重复提单时，
  // 复用已存在的待审批单，而不是制造两条互相竞争的 pending 幽灵记录。
  const active = approvals.find(approval =>
    approval.projectId === input.projectId
    && approval.entityType === input.entityType
    && approval.entityId === input.entityId
    && approval.status === 'pending');
  if (active) {
    if (idempotencyKey) idempotentCreates.set(idempotencyKey, { fingerprint, approval: active });
    return { value: active, replayed: true };
  }

  const item: Approval = { ...input, id: uniqueId('APR'), status: 'pending', createdAt: new Date().toISOString() };
  approvals.unshift(item);
  auditEvents.unshift({ id: uniqueId('AUD'), action: 'CREATE', entity: item.entityType, entityId: item.entityId, actor: item.requestedBy, at: item.createdAt, details: `提交审批：${item.title}` });
  if (idempotencyKey) idempotentCreates.set(idempotencyKey, { fingerprint, approval: item });
  return { value: item, replayed: false };
}

export function approve(id: string, status: Exclude<ApprovalStatus, 'pending'>, comment = '', actor = '当前审批人'): MutationResult<Approval> | undefined {
  const item = approvals.find(approval => approval.id === id);
  if (!item) return undefined;
  if (status !== 'approved' && status !== 'rejected') throw new ValidationError('status 必须是 approved 或 rejected');

  // 状态机：pending 是唯一可迁移状态。
  // - 相同动作重试（网络重发/双击）：幂等返回首次结果，不再写审计；
  // - 冲突动作（他人已通过又来驳回，反之亦然）：明确 409，绝不允许后一次静默覆盖前一次。
  if (item.status !== 'pending') {
    if (item.status === status) return { value: item, replayed: true };
    throw new ApprovalConflictError(`该审批已由 ${item.approver} ${item.status === 'approved' ? '通过' : '驳回'}，不能再执行${status === 'approved' ? '通过' : '驳回'}`, item);
  }

  item.status = status;
  item.comment = comment;
  auditEvents.unshift({ id: uniqueId('AUD'), action: status.toUpperCase(), entity: item.entityType, entityId: item.entityId, actor, at: new Date().toISOString(), details: comment || `${item.title} 已${status === 'approved' ? '通过' : '驳回'}` });
  return { value: item, replayed: false };
}

export function dashboard() { return projects.map(project => projectSummary(project.id)).map(summary => ({ id: summary.project?.id, title: summary.project?.title, status: summary.project?.status, forecast: summary.forecast, variance: summary.variance, pendingApprovals: summary.pendingApprovals, rightsConflicts: rightsConflicts(summary.project?.id).length })); }
