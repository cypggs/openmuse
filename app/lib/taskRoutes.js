// openmuse P1 — 后台任务 CRUD 路由（Worker C）。
//
// 只注册路由，不修改任何现有路由；接线见 TASK_INTEGRATION.md。
//
// ⚠ 进程内调度说明：定时触发依赖本进程常驻 tick。compute 休眠 / 缩容到 0
// 则定时不触发；开 always-on 是用户决策，**不要擅自改**。
'use strict';

const scheduler = require('./scheduler');

function rowToJson(r) {
  return {
    id: r.id,
    user_id: r.user_id,
    kind: r.kind,
    name: r.name,
    prompt: r.prompt,
    cron_expr: r.cron_expr,
    status: r.status,
    result: r.result,
    next_run_at: r.next_run_at,
    last_run_at: r.last_run_at,
    created_at: r.created_at,
  };
}

// registerTaskRoutes(app, { pool, requireUser })
// 所有路由：先 requireUser（用户隔离），再检查 pool（无 DB 时 503）。
function registerTaskRoutes(app, { pool, requireUser }) {
  if (!app || !pool || !requireUser) {
    throw new Error('registerTaskRoutes 需要 app、pool、requireUser');
  }
  // 防御性注入：即使 coordinator 忘了调 scheduler.setPool，路由依然可用
  scheduler.setPool(pool);

  const needPool = (req, res, next) => {
    if (!pool) {
      return res.status(503).json({
        error: 'database_not_configured',
        message: 'DATABASE_URL 未配置，任务功能不可用。',
      });
    }
    next();
  };

  // 创建任务：POST /api/tasks {name, prompt, kind='once', cron_expr?}
  app.post('/api/tasks', requireUser, needPool, async (req, res) => {
    const body = req.body || {};
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
    const kind = body.kind == null ? 'once' : String(body.kind).trim();
    const cronExpr = typeof body.cron_expr === 'string' ? body.cron_expr.trim() : '';

    if (!name) {
      return res.status(400).json({ error: 'invalid_name', message: '任务名称 name 不能为空' });
    }
    if (!prompt) {
      return res.status(400).json({ error: 'invalid_prompt', message: '任务内容 prompt 不能为空' });
    }
    if (kind !== 'once' && kind !== 'cron') {
      return res.status(400).json({ error: 'invalid_kind', message: 'kind 必须为 once 或 cron' });
    }
    if (kind === 'cron') {
      if (!cronExpr) {
        return res.status(400).json({ error: 'invalid_cron', message: 'cron 任务必须提供 cron_expr' });
      }
      try {
        scheduler.parseCron(cronExpr); // 提前校验，错误信息直接给前端
      } catch (e) {
        return res.status(400).json({ error: 'invalid_cron', message: e.message });
      }
    }

    try {
      const row = await scheduler.createTask({
        userId: req.userId,
        name,
        prompt,
        kind,
        cron_expr: kind === 'cron' ? cronExpr : undefined,
      });
      res.status(201).json(rowToJson(row));
    } catch (e) {
      res.status(400).json({ error: 'create_failed', message: e.message });
    }
  });

  // 任务列表：GET /api/tasks（当前用户，created_at DESC）
  app.get('/api/tasks', requireUser, needPool, async (req, res) => {
    try {
      const { rows } = await pool.query(
        'SELECT * FROM tasks WHERE user_id = $1 ORDER BY created_at DESC',
        [req.userId]
      );
      res.json(rows.map(rowToJson));
    } catch (e) {
      res.status(500).json({ error: 'db_error', message: e.message });
    }
  });

  // 单个任务：GET /api/tasks/:id（user_id 隔离，跨用户 404）
  app.get('/api/tasks/:id', requireUser, needPool, async (req, res) => {
    try {
      const { rows } = await pool.query('SELECT * FROM tasks WHERE id = $1 AND user_id = $2', [
        req.params.id,
        req.userId,
      ]);
      if (rows.length === 0) {
        return res.status(404).json({ error: 'not_found', message: '任务不存在' });
      }
      res.json(rowToJson(rows[0]));
    } catch (e) {
      res.status(500).json({ error: 'db_error', message: e.message });
    }
  });

  // 删除任务：DELETE /api/tasks/:id（user_id 隔离）
  app.delete('/api/tasks/:id', requireUser, needPool, async (req, res) => {
    try {
      const r = await pool.query('DELETE FROM tasks WHERE id = $1 AND user_id = $2', [
        req.params.id,
        req.userId,
      ]);
      if (r.rowCount === 0) {
        return res.status(404).json({ error: 'not_found', message: '任务不存在' });
      }
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: 'db_error', message: e.message });
    }
  });

  // 手动立即触发：POST /api/tasks/:id/run
  // 把 next_run_at 置 now() 且 status 置 'active'，下一次 tick 就会执行；幂等。
  // running 中的任务不重复触发，返回 409。
  app.post('/api/tasks/:id/run', requireUser, needPool, async (req, res) => {
    try {
      const r = await pool.query(
        `UPDATE tasks SET status = 'active', next_run_at = now()
         WHERE id = $1 AND user_id = $2 AND status IN ('active', 'done', 'failed')
         RETURNING *`,
        [req.params.id, req.userId]
      );
      if (r.rowCount > 0) return res.json(rowToJson(r.rows[0]));
      const own = await pool.query('SELECT status FROM tasks WHERE id = $1 AND user_id = $2', [
        req.params.id,
        req.userId,
      ]);
      if (own.rowCount === 0) {
        return res.status(404).json({ error: 'not_found', message: '任务不存在' });
      }
      return res.status(409).json({ error: 'task_running', message: '任务正在运行中，无需重复触发' });
    } catch (e) {
      res.status(500).json({ error: 'db_error', message: e.message });
    }
  });
}

module.exports = { registerTaskRoutes };
