import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  ApprovalConflictError,
  IdempotencyConflictError,
  approvals,
  approve,
  auditEvents,
  createApproval,
  projectSummary,
  uniqueId,
} from './domain.js';

const countUnique = <T>(items: T[]) => new Set(items).size;

test('uniqueId never collides under burst concurrency', async () => {
  const burst = 1000;
  const ids = (await Promise.all(
    Array.from({ length: burst }, () => Promise.resolve(uniqueId('APR')))
  )).concat(
    // 同一事件循环 tick 内的同步批量调用也要唯一
    Array.from({ length: burst }, () => uniqueId('AUD'))
  );
  assert.equal(ids.length, burst * 2);
  assert.equal(countUnique(ids), ids.length);
});

test('concurrent approval creation from two browsers yields distinct ids', async () => {
  const [finance, producer] = await Promise.all([
    Promise.resolve().then(() => createApproval({
      projectId: 'PRJ-002', entityType: 'budget', entityId: `BUD-CONC-${randomUUID()}`,
      title: '财务提交', requestedBy: '财务负责人', approver: '总制片人',
    }, randomUUID())),
    Promise.resolve().then(() => createApproval({
      projectId: 'PRJ-002', entityType: 'budget', entityId: `BUD-CONC-${randomUUID()}`,
      title: '制片提交', requestedBy: '制片主任', approver: '总制片人',
    }, randomUUID())),
  ]);
  assert.notEqual(finance.value.id, producer.value.id);
  assert.equal(finance.replayed, false);
  assert.equal(producer.replayed, false);
});

test('network retry with the same Idempotency-Key replays instead of creating ghost approval', async () => {
  const key = randomUUID();
  const payload = {
    projectId: 'PRJ-002', entityType: 'delivery' as const, entityId: `DEL-RETRY-${randomUUID()}`,
    title: '网络重试提单', requestedBy: '发行部', approver: '法务负责人',
  };
  const pendingBefore = projectSummary('PRJ-002').pendingApprovals;
  const [first, second, third] = await Promise.all([
    Promise.resolve().then(() => createApproval({ ...payload }, key)),
    Promise.resolve().then(() => createApproval({ ...payload }, key)),
    Promise.resolve().then(() => createApproval({ ...payload }, key)),
  ]);
  assert.equal(first.value.id, second.value.id);
  assert.equal(first.value.id, third.value.id);
  assert.equal(first.replayed, false);
  assert.equal(second.replayed, true);
  assert.equal(third.replayed, true);
  assert.equal(projectSummary('PRJ-002').pendingApprovals, pendingBefore + 1);
  // CREATE 审计只能有一条
  const creates = auditEvents.filter(e => e.entityId === payload.entityId && e.action === 'CREATE');
  assert.equal(creates.length, 1);
});

test('same key with different payload is rejected rather than silently replayed', () => {
  const key = randomUUID();
  createApproval({
    projectId: 'PRJ-002', entityType: 'delivery', entityId: `DEL-KEY-${randomUUID()}`,
    title: '原始提单', requestedBy: '发行部', approver: '法务负责人',
  }, key);
  assert.throws(() => createApproval({
    projectId: 'PRJ-002', entityType: 'delivery', entityId: `DEL-KEY-OTHER-${randomUUID()}`,
    title: '篡改提单', requestedBy: '发行部', approver: '法务负责人',
  }, key), IdempotencyConflictError);
});

test('duplicate submissions without idempotency key still collapse on the pending entity', async () => {
  const entityId = `DEL-DUP-${randomUUID()}`;
  const payload = {
    projectId: 'PRJ-002', entityType: 'delivery' as const, entityId,
    title: '双击重复提单', requestedBy: '发行部', approver: '法务负责人',
  };
  const [a, b] = await Promise.all([
    Promise.resolve().then(() => createApproval({ ...payload })),
    Promise.resolve().then(() => createApproval({ ...payload })),
  ]);
  assert.equal(a.value.id, b.value.id);
  assert.equal(approvals.filter(item => item.entityId === entityId).length, 1);
  const creates = auditEvents.filter(e => e.entityId === entityId && e.action === 'CREATE');
  assert.equal(creates.length, 1);
});

test('competing approve/reject actions: first wins, conflicting second is a 409 not a silent overwrite', async () => {
  const created = createApproval({
    projectId: 'PRJ-002', entityType: 'asset', entityId: `AST-RACE-${randomUUID()}`,
    title: '并发处理对象', requestedBy: '后期制片', approver: '总制片人',
  }, randomUUID()).value;

  const outcomes = await Promise.allSettled([
    Promise.resolve().then(() => approve(created.id, 'approved', '财务同意')),
    Promise.resolve().then(() => approve(created.id, 'rejected', '制片驳回')),
  ]);
  const statuses = outcomes.map(o => o.status);
  assert.ok(statuses.includes('fulfilled'));
  assert.ok(statuses.includes('rejected'));
  const error = outcomes.find(o => o.status === 'rejected') as PromiseRejectedResult;
  assert.ok(error.reason instanceof ApprovalConflictError);

  const finalItem = approvals.find(a => a.id === created.id)!;
  // 只有先落地的动作可以决定状态，且其值就是拒绝方拿到的 current
  assert.ok(finalItem.status === 'approved' || finalItem.status === 'rejected');
  assert.equal((error.reason as ApprovalConflictError).current.status, finalItem.status);

  // 审计：只有一次状态变更，且 id 唯一
  const events = auditEvents.filter(e => e.entityId === created.entityId);
  assert.equal(events.filter(e => e.action === 'APPROVED' || e.action === 'REJECTED').length, 1);
  assert.equal(countUnique(auditEvents.map(e => e.id)), auditEvents.length);
});

test('identical approve action retried is idempotent and writes no second audit event', () => {
  const created = createApproval({
    projectId: 'PRJ-002', entityType: 'asset', entityId: `AST-IDEM-${randomUUID()}`,
    title: '重复同意', requestedBy: '后期制片', approver: '总制片人',
  }, randomUUID()).value;

  const first = approve(created.id, 'approved', '同意');
  const second = approve(created.id, 'approved', '同意');
  assert.equal(first?.replayed, false);
  assert.equal(second?.replayed, true);
  assert.equal(second?.value.status, 'approved');
  const decisions = auditEvents.filter(e => e.entityId === created.entityId && e.action === 'APPROVED');
  assert.equal(decisions.length, 1);
});

test('pending count after refresh matches real state and never counts ghost records', async () => {
  const before = projectSummary('PRJ-002').pendingApprovals;
  const key = randomUUID();
  const payload = {
    projectId: 'PRJ-002', entityType: 'budget' as const, entityId: `BUD-COUNT-${randomUUID()}`,
    title: '计数校验', requestedBy: '制片主任', approver: '财务负责人',
  };
  await Promise.all([
    createApproval({ ...payload }, key),
    createApproval({ ...payload }, key),
    createApproval({ ...payload }, key),
  ]);
  assert.equal(projectSummary('PRJ-002').pendingApprovals, before + 1);
  approve(approvals.find(a => a.entityId === payload.entityId)!.id, 'approved', 'ok');
  assert.equal(projectSummary('PRJ-002').pendingApprovals, before);
});
