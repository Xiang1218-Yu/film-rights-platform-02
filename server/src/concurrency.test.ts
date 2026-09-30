import test from 'node:test';
import assert from 'node:assert/strict';
import { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { app } from './index.ts';
import { approvals, auditEvents, ApprovalConflictError, createApproval, decideApproval, projectSummary } from './domain.ts';

// ---------- 领域层：同毫秒高压下的标识唯一性与状态转移 ----------

test('高压下每个审批与审计事件都有唯一标识（不再依赖 Date.now()）', async () => {
  const created = await Promise.all(Array.from({ length: 1000 }, (_, i) =>
    createApproval({ projectId: 'PRJ-001', entityType: 'budget', entityId: `BUD-RACE-${i}`, title: `并发审批 ${i}`, requestedBy: '制片主任', approver: '财务负责人' }),
  ));
  const approvalIds = created.map(r => r.approval.id);
  assert.equal(new Set(approvalIds).size, 1000, '1000 个审批 id 必须互不相同');
  const auditIds = auditEvents.map(e => e.id);
  assert.equal(new Set(auditIds).size, auditIds.length, '审计事件 id 必须全局唯一');
});

test('相同 Idempotency-Key 的创建重试回放同一审批，只产生一条审计', async () => {
  const input = { projectId: 'PRJ-002', entityType: 'delivery' as const, entityId: 'DEL-IDEM-1', title: '网络重试创建', requestedBy: '发行部', approver: '法务负责人' };
  const before = auditEvents.length;
  const [first, retry] = await Promise.all([createApproval(input, 'client-key-create-1'), createApproval(input, 'client-key-create-1')]);
  assert.equal(first.statusCode, 201);
  assert.equal(retry.approval.id, first.approval.id);
  assert.equal(retry.replayed, true, '并发到达的同键请求必须被识别为回放');
  assert.equal(auditEvents.length - before, 1, '重试不得写第二条审计/幽灵审批');
});

test('无幂等键的重复提交命中同一 pending 审批的业务去重', async () => {
  const input = { projectId: 'PRJ-002', entityType: 'asset' as const, entityId: 'AST-IDEM-2', title: '双击重复', requestedBy: '营销部', approver: '总制片人' };
  const [first, second] = await Promise.all([createApproval(input), createApproval(input)]);
  assert.equal(first.statusCode, 201);
  assert.equal(second.statusCode, 200);
  assert.equal(second.deduplicated, true);
  assert.equal(second.approval.id, first.approval.id);
});

test('审批状态只能转移一次：后到的冲突动作抛 409 而不是覆盖', async () => {
  const target = await createApproval({ projectId: 'PRJ-001', entityType: 'budget', entityId: 'BUD-RACE-DECIDE', title: '竞争处理', requestedBy: '制片主任', approver: '财务负责人' });
  const approved = await decideApproval(target.approval.id, 'approved', '同意', '总制片人', 'key-approve');
  assert.equal(approved.approval.status, 'approved');
  await assert.rejects(
    () => decideApproval(target.approval.id, 'rejected', '改判驳回', '财务负责人', 'key-reject'),
    (error: unknown) => error instanceof ApprovalConflictError,
  );
  const fresh = approvals.find(a => a.id === target.approval.id)!;
  assert.equal(fresh.status, 'approved', '被拒绝的冲突动作不得覆盖已生效状态');
  assert.equal(fresh.comment, '同意');
});

test('相同动作的重复/重试幂等：不新增审计，回放同一状态', async () => {
  const target = await createApproval({ projectId: 'PRJ-002', entityType: 'budget', entityId: 'BUD-RACE-DUP', title: '重复通过', requestedBy: '制片主任', approver: '财务负责人' });
  const before = auditEvents.filter(e => e.approvalId === target.approval.id).length; // 含创建时的 SUBMIT
  const first = await decideApproval(target.approval.id, 'approved', '通过', '财务负责人', 'same-action-key');
  assert.equal(first.statusCode, 200);
  // 同键网络重试：键级回放
  const keyedRetry = await decideApproval(target.approval.id, 'approved', '通过', '财务负责人', 'same-action-key');
  assert.equal(keyedRetry.replayed, true);
  // 无键双击重复同一动作：状态机去重，不再转移、不再写审计
  const plainRetry = await decideApproval(target.approval.id, 'approved', '通过', '财务负责人');
  assert.equal(plainRetry.statusCode, 200);
  const after = auditEvents.filter(e => e.approvalId === target.approval.id).length;
  assert.equal(after - before, 1, '同一动作只允许一条 APPROVED 审计事件');
});

// ---------- HTTP 层：Promise.all 并发与故意重复请求 ----------

async function call(server: Server, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const port = (server.address() as AddressInfo).port;
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json', ...headers } : headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, replay: res.headers.get('idempotent-replay'), dedup: res.headers.get('idempotent-deduplicated'), body: await res.json() };
}

test('HTTP：财务负责人与制片主任并发提交不同审批，资源与审计标识全部唯一', async t => {
  const server = app.listen(0);
  t.after(() => server.close());
  const inputs = Array.from({ length: 20 }, (_, i) => ({
    projectId: i % 2 ? 'PRJ-001' : 'PRJ-002', entityType: 'delivery' as const, entityId: `DEL-HTTP-${i}`,
    title: `并发提交 ${i}`, requestedBy: i % 2 ? '制片主任' : '财务负责人', approver: '总制片人',
  }));
  const responses = await Promise.all(inputs.map(body => call(server, 'POST', '/api/approvals', body)));
  assert.ok(responses.every(r => r.status === 201));
  const ids = responses.map(r => r.body.id);
  assert.equal(new Set(ids).size, ids.length);

  const audit = await call(server, 'GET', '/api/audit-events');
  const auditIds = audit.body.map((e: { id: string }) => e.id);
  assert.equal(new Set(auditIds).size, auditIds.length);
});

test('HTTP：同一创建请求重试两次只落一条记录，并带回放标记', async t => {
  const server = app.listen(0);
  t.after(() => server.close());
  const body = { projectId: 'PRJ-001', entityType: 'delivery', entityId: 'DEL-HTTP-RETRY', title: '网络重试', requestedBy: '发行部', approver: '法务负责人' };
  const retryKey = `http-retry-key-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const [first, retry] = await Promise.all([
    call(server, 'POST', '/api/approvals', body, { 'Idempotency-Key': retryKey }),
    call(server, 'POST', '/api/approvals', body, { 'Idempotency-Key': retryKey }),
  ]);
  assert.equal(first.status, 201);
  assert.equal(retry.status, 201);
  assert.equal(first.body.id, retry.body.id);
  const replays = [first.replay, retry.replay];
  assert.deepEqual(replays.filter(v => v === 'true').length, 1, '并发下恰好一个请求被识别为幂等回放');
  assert.deepEqual(replays.filter(v => v === 'false').length, 1);
});

test('HTTP：同一审批并发 approve/reject，一个 200 一个 409，刷新后状态不被覆盖', async t => {
  const server = app.listen(0);
  t.after(() => server.close());
  const created = await call(server, 'POST', '/api/approvals', {
    projectId: 'PRJ-001', entityType: 'asset', entityId: 'AST-HTTP-RACE', title: '并发处理', requestedBy: '后期制片', approver: '总制片人',
  });
  const id = created.body.id;
  const [approval, rejection] = await Promise.all([
    call(server, 'PATCH', `/api/approvals/${id}`, { status: 'approved', comment: '通过', actor: '总制片人' }, { 'Idempotency-Key': 'http-approve' }),
    call(server, 'PATCH', `/api/approvals/${id}`, { status: 'rejected', comment: '驳回', actor: '财务负责人' }, { 'Idempotency-Key': 'http-reject' }),
  ]);
  const statuses = [approval.status, rejection.status].sort();
  assert.deepEqual(statuses, [200, 409]);

  const summary = await call(server, 'GET', '/api/projects/PRJ-001/summary');
  const refreshed = summary.body.approvals.find((a: { id: string }) => a.id === id);
  assert.equal(refreshed.status, 'approved');

  const summaryPending = summary.body.approvals.filter((a: { status: string }) => a.status === 'pending').length;
  assert.equal(summary.body.pendingApprovals, summaryPending, '待审批计数必须与列表实际状态一致');
});

test('HTTP：同一动作并发双击只产生一条审计事件', async t => {
  const server = app.listen(0);
  t.after(() => server.close());
  const created = await call(server, 'POST', '/api/approvals', {
    projectId: 'PRJ-002', entityType: 'delivery', entityId: 'DEL-HTTP-DBL', title: '双击通过', requestedBy: '发行部', approver: '法务负责人',
  });
  const id = created.body.id;
  const [a, b] = await Promise.all([
    call(server, 'PATCH', `/api/approvals/${id}`, { status: 'approved', comment: '第一次' }),
    call(server, 'PATCH', `/api/approvals/${id}`, { status: 'approved', comment: '第二次' }),
  ]);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  const audit = await call(server, 'GET', '/api/audit-events');
  const related = audit.body.filter((e: { approvalId?: string }) => e.approvalId === id);
  assert.equal(related.length, 2, '应有 SUBMIT + APPROVED 两条不同事件');
  assert.equal(related.filter((e: { action: string }) => e.action === 'APPROVED').length, 1, '并发双击只能产生一条动作审计');
});

test('清理：全部并发操作后两项目的待审批计数仍与实际一致', () => {
  for (const projectId of ['PRJ-001', 'PRJ-002']) {
    const summary = projectSummary(projectId);
    assert.equal(summary.pendingApprovals, summary.approvals.filter(a => a.status === 'pending').length);
  }
});
