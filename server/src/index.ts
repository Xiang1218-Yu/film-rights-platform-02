import express from 'express';
import { ApprovalConflictError, IdempotencyConflictError, ValidationError, approve, assets, auditEvents, budgetLines, contracts, createApproval, dashboard, projectSummary, projects, rightsConflicts } from './domain.js';

export function createServer() {
  const app = express();
  app.use(express.json());

  app.get('/api/dashboard', (_req, res) => res.json(dashboard()));
  app.get('/api/projects', (_req, res) => res.json(projects));
  app.get('/api/projects/:id/summary', (req, res) => { const result = projectSummary(req.params.id); if (!result.project) return res.status(404).json({ message: '项目不存在' }); res.json(result); });
  app.get('/api/projects/:id/rights-conflicts', (req, res) => res.json(rightsConflicts(req.params.id)));
  app.get('/api/projects/:id/assets', (req, res) => res.json(assets.filter(asset => asset.projectId === req.params.id)));
  app.get('/api/projects/:id/contracts', (req, res) => res.json(contracts.filter(contract => contract.projectId === req.params.id)));
  app.get('/api/budgets/:projectId/lines', (req, res) => res.json(budgetLines.filter(line => line.projectId === req.params.projectId)));
  app.get('/api/audit-events', (req, res) => {
    const { entity, entityId } = req.query;
    let list = auditEvents;
    if (typeof entity === 'string') list = list.filter(event => event.entity === entity);
    if (typeof entityId === 'string') list = list.filter(event => event.entityId === entityId);
    res.json(list);
  });

  // 创建审批：客户端对同一点击/重试必须携带稳定的 Idempotency-Key。
  // 首次创建返回 201；重放返回 200 + Idempotent-Replay: true，语义明确。
  app.post('/api/approvals', (req, res) => {
    try {
      const result = createApproval(req.body ?? {}, header(req, 'idempotency-key'));
      res.status(result.replayed ? 200 : 201);
      res.setHeader('Idempotent-Replay', String(result.replayed));
      res.json(result.value);
    } catch (error) {
      respondError(res, error);
    }
  });

  app.patch('/api/approvals/:id', (req, res) => {
    try {
      const actor = typeof req.body?.actor === 'string' && req.body.actor.trim() ? req.body.actor : '当前审批人';
      const result = approve(req.params.id, req.body.status, req.body.comment ?? '', actor);
      if (!result) return res.status(404).json({ message: '审批不存在' });
      res.setHeader('Idempotent-Replay', String(result.replayed));
      res.json({ ...result.value, replayed: result.replayed });
    } catch (error) {
      respondError(res, error);
    }
  });

  app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'film-rights-platform' }));
  return app;
}

function header(req: express.Request, name: string): string | undefined {
  const value = req.headers[name];
  return typeof value === 'string' && value.trim() ? value.trim() : Array.isArray(value) ? value[0] : undefined;
}

function respondError(res: express.Response, error: unknown) {
  if (error instanceof ValidationError) return res.status(400).json({ code: error.code, message: error.message });
  if (error instanceof ApprovalConflictError) return res.status(409).json({ code: error.code, message: error.message, current: error.current });
  if (error instanceof IdempotencyConflictError) return res.status(409).json({ code: error.code, message: error.message });
  console.error('unhandled approval error', error);
  return res.status(500).json({ message: '服务内部错误' });
}

// 仅在直接启动进程时监听端口，供集成测试通过 createServer() 复用同一 app。
if (process.argv[1] && process.argv[1].endsWith('index.ts')) {
  const port = Number(process.env.PORT || 4104);
  createServer().listen(port, () => console.log(`film rights API listening on ${port}`));
}
