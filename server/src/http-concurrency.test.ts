import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createServer } from './index.js';

let base = '';
let server: Server;

test.before(async () => {
  server = createServer().listen(0);
  await new Promise<void>((resolve, reject) => {
    server.once('listening', () => resolve());
    server.once('error', reject);
  });
  const { port } = server.address() as AddressInfo;
  base = `http://127.0.0.1:${port}/api`;
});

test.after(() => {
  server?.close();
});

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: body === undefined ? headers : { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await response.json().catch(() => ({}));
  return { status: response.status, replay: response.headers.get('Idempotent-Replay'), json };
}

test('HTTP: duplicated POST retries create exactly one approval and share the same id', async () => {
  const key = randomUUID();
  const payload = {
    projectId: 'PRJ-001', entityType: 'delivery', entityId: `DEL-HTTP-${randomUUID()}`,
    title: '跨浏览器并发提单', requestedBy: '制片主任', approver: '法务负责人',
  };
  const responses = await Promise.all([
    call('POST', '/approvals', payload, { 'Idempotency-Key': key }),
    call('POST', '/approvals', payload, { 'Idempotency-Key': key }),
    call('POST', '/approvals', payload, { 'Idempotency-Key': key }),
  ]);
  const statuses = responses.map(r => r.status).sort();
  assert.deepEqual(statuses, [200, 200, 201]);
  const ids = new Set(responses.map(r => r.json.id));
  assert.equal(ids.size, 1);

  const summary = await call('GET', '/projects/PRJ-001/summary');
  const rows = summary.json.approvals.filter((a: { entityId: string }) => a.entityId === payload.entityId);
  assert.equal(rows.length, 1);

  const audit = await call('GET', `/audit-events?entityId=${encodeURIComponent(payload.entityId)}`);
  assert.equal(audit.json.length, 1);
  assert.ok(audit.json[0].id.startsWith('AUD-'));
});

test('HTTP: two browsers submitting the same entity without key get one stable pending row', async () => {
  const payload = {
    projectId: 'PRJ-001', entityType: 'budget', entityId: `BUD-HTTP-${randomUUID()}`,
    title: '无键重复提交', requestedBy: '财务负责人', approver: '总制片人',
  };
  const [r1, r2] = await Promise.all([call('POST', '/approvals', payload), call('POST', '/approvals', payload)]);
  assert.equal(r1.json.id, r2.json.id);
});

test('HTTP: parallel approve and reject — one succeeds, the other gets 409 with the winning state', async () => {
  const created = await call('POST', '/approvals', {
    projectId: 'PRJ-001', entityType: 'asset', entityId: `AST-HTTP-${randomUUID()}`,
    title: '并发审批争夺', requestedBy: '后期制片', approver: '财务负责人',
  }, { 'Idempotency-Key': randomUUID() });
  const id = created.json.id as string;

  const [a, b] = await Promise.all([
    call('PATCH', `/approvals/${id}`, { status: 'approved', comment: '通过', actor: '财务负责人' }),
    call('PATCH', `/approvals/${id}`, { status: 'rejected', comment: '驳回', actor: '制片主任' }),
  ]);
  const codes = [a.status, b.status].sort();
  assert.deepEqual(codes, [200, 409]);

  const winner = a.status === 200 ? a : b;
  const loser = a.status === 409 ? a : b;
  assert.equal(loser.json.current.status, winner.json.status);
  assert.match(String(loser.json.message), /已由/);

  // 刷新后的详情只反映获胜动作，pending 计数相应减少
  const detail = await call('GET', '/projects/PRJ-001/summary');
  const row = detail.json.approvals.find((item: { id: string }) => item.id === id);
  assert.equal(row.status, winner.json.status);

  const audit = await call('GET', `/audit-events?entityId=${encodeURIComponent(row.entityId)}`);
  const decisionEvents = audit.json.filter((e: { action: string }) => e.action === 'APPROVED' || e.action === 'REJECTED');
  assert.equal(decisionEvents.length, 1);
  assert.equal(new Set(audit.json.map((e: { id: string }) => e.id)).size, audit.json.length);
});

test('HTTP: retried identical PATCH is an idempotent replay with no extra audit row', async () => {
  const created = await call('POST', '/approvals', {
    projectId: 'PRJ-001', entityType: 'delivery', entityId: `DEL-PATCH-${randomUUID()}`,
    title: '重复处理', requestedBy: '发行部', approver: '法务负责人',
  }, { 'Idempotency-Key': randomUUID() });
  const id = created.json.id as string;

  const [r1, r2] = await Promise.all([
    call('PATCH', `/approvals/${id}`, { status: 'approved', comment: 'ok' }),
    call('PATCH', `/approvals/${id}`, { status: 'approved', comment: 'ok' }),
  ]);
  assert.equal(r1.status, 200);
  assert.equal(r2.status, 200);
  assert.equal(r1.replay, 'false');
  assert.equal(r2.replay, 'true');

  const audit = await call('GET', `/audit-events?entityId=${encodeURIComponent(created.json.entityId)}`);
  assert.equal(audit.json.filter((e: { action: string }) => e.action === 'APPROVED').length, 1);
});

test('HTTP: invalid status and missing fields are rejected with 400', async () => {
  const bad = await call('PATCH', '/approvals/APR-03', { status: 'maybe' });
  assert.equal(bad.status, 400);
  const missing = await call('POST', '/approvals', { projectId: 'PRJ-001' }, { 'Idempotency-Key': randomUUID() });
  assert.equal(missing.status, 400);
});
