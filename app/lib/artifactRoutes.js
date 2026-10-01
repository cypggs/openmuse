// openmuse P1 Worker B — artifact REST 路由。
// 由 coordinator 在 server.js 中调用 registerArtifactRoutes(app, {pool, requireUser}) 注册。
// 不修改现有 server.js / agent.js / index.html，只新增本模块。
'use strict';

const artifacts = require('./artifacts');

function registerArtifactRoutes(app, opts) {
  const { pool, requireUser } = opts || {};

  // 让 lib/artifacts 拿到同一份 pool（无 pool 时本模块的 requireDb 直接 503）
  artifacts.setPool(pool);

  function requireDb(req, res, next) {
    if (!pool) {
      return res.status(503).json({
        error: 'database_not_configured',
        message: 'DATABASE_URL 未配置，artifact 功能不可用。请设置环境变量后重启服务。',
      });
    }
    next();
  }

  // 列表：GET /api/artifacts?session_id=
  app.get('/api/artifacts', requireDb, requireUser, async (req, res) => {
    try {
      const sessionId = typeof req.query.session_id === 'string' ? req.query.session_id : undefined;
      res.json(await artifacts.listArtifacts(req.userId, sessionId));
    } catch (e) {
      res.status(500).json({ error: 'db_error', message: '读取 artifact 列表失败：' + e.message });
    }
  });

  // 详情：GET /api/artifacts/:id
  app.get('/api/artifacts/:id', requireDb, requireUser, async (req, res) => {
    try {
      const row = await artifacts.getArtifact(req.userId, req.params.id);
      if (!row) {
        return res.status(404).json({ error: 'not_found', message: 'artifact 不存在' });
      }
      res.json(row);
    } catch (e) {
      res.status(500).json({ error: 'db_error', message: '读取 artifact 失败：' + e.message });
    }
  });

  // 删除：DELETE /api/artifacts/:id
  app.delete('/api/artifacts/:id', requireDb, requireUser, async (req, res) => {
    try {
      const n = await artifacts.deleteArtifact(req.userId, req.params.id);
      if (!n) {
        return res.status(404).json({ error: 'not_found', message: 'artifact 不存在' });
      }
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: 'db_error', message: '删除 artifact 失败：' + e.message });
    }
  });
}

module.exports = { registerArtifactRoutes };
