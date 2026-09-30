import express from 'express';
import { ApprovalConflictError, ApprovalStatus, assets, auditEvents, budgetLines, contracts, createApproval, dashboard, decideApproval, projectSummary, projects, rightsConflicts } from './domain.js';

const app = express();
app.use(express.json());

app.get('/api/dashboard', (_req, res) => res.json(dashboard()));
app.get('/api/projects', (_req, res) => res.json(projects));
app.get('/api/projects/:id/summary', (req, res) => { const result = projectSummary(req.params.id); if (!result.project) return res.status(404).json({ message: '项目不存在' }); res.json(result); });
app.get('/api/projects/:id/rights-conflicts', (req, res) => res.json(rightsConflicts(req.params.id)));
app.get('/api/projects/:id/assets', (req, res) => res.json(assets.filter(asset => asset.projectId === req.params.id)));
app.get('/api/projects/:id/contracts', (req, res) => res.json(contracts.filter(contract => contract.projectId === req.params.id)));
app.get('/api/budgets/:projectId/lines', (req, res) => res.json(budgetLines.filter(line => line.projectId === req.params.projectId)));
app.get('/api/audit-events', (_req, res) => res.json(auditEvents));

// 创建审批：客户端用 Idempotency-Key 标识“同一个提交动作”，网络重试安全回放
app.post('/api/approvals', async (req, res) => {
  const { projectId, entityType, entityId, title, requestedBy, approver } = req.body ?? {};
  if (!projectId || !entityType || !entityId || !title || !requestedBy || !approver) {
    return res.status(400).json({ message: '缺少必填字段：projectId/entityType/entityId/title/requestedBy/approver' });
  }
  const key = req.header('Idempotency-Key');
  const result = await createApproval({ projectId, entityType, entityId, title, requestedBy, approver }, key);
  res.setHeader('Idempotent-Replay', result.replayed ? 'true' : 'false');
  if (result.deduplicated) res.setHeader('Idempotent-Deduplicated', 'true');
  res.status(result.statusCode).json(result.approval);
});

// 处理审批：同一动作的重试幂等回放；不同动作并发到达时 409，不允许后写覆盖前写
app.patch('/api/approvals/:id', async (req, res) => {
  const status = String(req.body?.status ?? '') as ApprovalStatus;
  if (status !== 'approved' && status !== 'rejected') {
    return res.status(400).json({ message: 'status 必须是 approved 或 rejected' });
  }
  const comment = String(req.body?.comment ?? '');
  const actor = String(req.body?.actor ?? '当前审批人');
  const key = req.header('Idempotency-Key');
  try {
    const result = await decideApproval(req.params.id, status, comment, actor, key);
    res.setHeader('Idempotent-Replay', result.replayed ? 'true' : 'false');
    if (result.statusCode === 404) return res.status(404).json({ message: '审批不存在' });
    return res.status(200).json(result.approval);
  } catch (error) {
    if (error instanceof ApprovalConflictError) {
      return res.status(409).json({ message: error.message, currentStatus: error.current.status, approval: error.current });
    }
    throw error;
  }
});

app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'film-rights-platform' }));

// 兼容直接导入 app 的测试/启动方式：仅在被直接运行时监听端口
const entryPath = process.argv[1] ? new URL(`file://${process.argv[1]}`).pathname : '';
if (entryPath.endsWith('/index.ts') || entryPath.endsWith('/index.js')) {
  const port = Number(process.env.PORT || 4104);
  app.listen(port, () => console.log(`film rights API listening on ${port}`));
}

export { app };
