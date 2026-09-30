import test from 'node:test'; import assert from 'node:assert/strict';
import { approve, projectSummary, rightsConflicts } from './domain.js';

test('budget summary exposes forecast variance and high risk lines', () => { const summary = projectSummary('PRJ-001'); assert.equal(summary.lines.length, 4); assert.ok(summary.forecast > summary.planned); assert.equal(summary.highRiskLines.length, 1); });
test('rights conflict engine detects overlapping licensed assets', () => { const conflicts = rightsConflicts('PRJ-001'); assert.ok(conflicts.length >= 1); assert.ok(conflicts.some(item => item.reason.includes('音乐-同步许可'))); });
test('approval changes are auditable and stateful', () => { const result = approve('APR-02', 'approved', '母版已复核'); assert.equal(result?.value.status, 'approved'); assert.equal(result?.value.comment, '母版已复核'); assert.equal(result?.replayed, false); });
