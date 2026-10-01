// openmuse P1 MVP — minimal chat server (Express + pg, no build step).
// Secrets (DEEPSEEK_API_KEY, DATABASE_URL) are read only from process.env
// and are never logged or written anywhere.
'use strict';

const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');
const agent = require('./lib/agent');
const sandboxMgr = require('./lib/sandbox');

const PORT = Number(process.env.PORT) || 3000;
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || '';
const DATABASE_URL = process.env.DATABASE_URL || '';

const app = express();
app.use(express.json({ limit: '1mb' }));

// ---------- database ----------
let pool = null;
if (DATABASE_URL) {
  const needsSsl = !/(localhost|127\.0\.0\.1)/.test(DATABASE_URL);
  pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: needsSsl ? { rejectUnauthorized: false } : undefined,
  });
  pool.on('error', (err) => console.error('[openmuse] pg pool error:', err.message));
  sandboxMgr.setPool(pool);
} else {
  console.warn('[openmuse] DATABASE_URL 未设置：以无持久化模式运行，会话与消息不会保存');
}
sandboxMgr.startReaper();

async function initDb() {
  if (!pool) return;
  await pool.query(`CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    title TEXT,
    created_at TIMESTAMPTZ DEFAULT now()
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS messages (
    id SERIAL PRIMARY KEY,
    session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
    role TEXT,
    content TEXT,
    created_at TIMESTAMPTZ DEFAULT now()
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS user_sandboxes (
    user_id TEXT PRIMARY KEY,
    sandbox_id TEXT,
    status TEXT,
    last_active_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT now()
  )`);
  // v2.1: native snapshot checkpoint column
  await pool.query(`ALTER TABLE user_sandboxes ADD COLUMN IF NOT EXISTS snapshot_id TEXT`);
  console.log('[openmuse] database ready');
}

function requireDb(req, res, next) {
  if (!pool) {
    return res.status(503).json({
      error: 'database_not_configured',
      message: 'DATABASE_URL 未配置，无法使用会话与聊天功能。请设置环境变量后重启服务。',
    });
  }
  next();
}

// ---------- api ----------
app.get('/api/health', (req, res) => res.json({ ok: true }));

app.get('/api/sessions', requireDb, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT s.id, s.title, s.created_at
      FROM sessions s
      LEFT JOIN messages m ON m.session_id = s.id
      GROUP BY s.id
      ORDER BY COALESCE(MAX(m.created_at), s.created_at) DESC
    `);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: 'db_error', message: e.message });
  }
});

app.post('/api/sessions', requireDb, async (req, res) => {
  try {
    const id = crypto.randomUUID();
    const title = (req.body && typeof req.body.title === 'string' && req.body.title.trim()) || '新的对话';
    await pool.query('INSERT INTO sessions (id, title) VALUES ($1, $2)', [id, title]);
    res.json({ id });
  } catch (e) {
    res.status(500).json({ error: 'db_error', message: e.message });
  }
});

app.get('/api/sessions/:id/messages', requireDb, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT role, content, created_at FROM messages WHERE session_id = $1 ORDER BY id ASC',
      [req.params.id]
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: 'db_error', message: e.message });
  }
});

app.delete('/api/sessions/:id', requireDb, async (req, res) => {
  try {
    const r = await pool.query('DELETE FROM sessions WHERE id = $1', [req.params.id]);
    if (r.rowCount === 0) return res.status(404).json({ error: 'not_found', message: '会话不存在' });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'db_error', message: e.message });
  }
});

app.post('/api/chat', requireDb, async (req, res) => {
  const body = req.body || {};
  const message = typeof body.message === 'string' ? body.message.trim() : '';
  let sessionId = typeof body.sessionId === 'string' ? body.sessionId : '';

  if (!message) {
    return res.status(400).json({ error: 'empty_message', message: 'message 不能为空' });
  }
  if (!DEEPSEEK_API_KEY) {
    return res.status(503).json({
      error: 'llm_not_configured',
      message: 'DEEPSEEK_API_KEY 未配置，无法调用模型。请设置环境变量后重启服务。',
    });
  }

  try {
    // Ensure session exists (create on demand).
    let sessionExists = false;
    if (sessionId) {
      const s = await pool.query('SELECT id FROM sessions WHERE id = $1', [sessionId]);
      sessionExists = s.rowCount > 0;
    }
    if (!sessionExists) {
      sessionId = crypto.randomUUID();
      const title = Array.from(message).slice(0, 24).join('') || '新的对话';
      await pool.query('INSERT INTO sessions (id, title) VALUES ($1, $2)', [sessionId, title]);
    }

    await pool.query('INSERT INTO messages (session_id, role, content) VALUES ($1, $2, $3)', [
      sessionId,
      'user',
      message,
    ]);

    const hist = await pool.query(
      'SELECT role, content FROM messages WHERE session_id = $1 ORDER BY id DESC LIMIT 30',
      [sessionId]
    );
    const history = hist.rows.reverse().map((r) => ({ role: r.role, content: r.content }));

    // ---- SSE response ----
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const send = (obj) => {
      try {
        res.write(`data: ${JSON.stringify(obj)}\n\n`);
      } catch (_) {}
    };
    send({ t: 'sessionId', sessionId });

    // v2: agent tool loop over the per-user sandbox.
    // Streams {t:'token'|'tool_start'|'tool_end'|'error'} events to the client.
    let clientGone = false;
    req.on('close', () => {
      clientGone = true;
    });

    let full = '';
    try {
      const r = await agent.runAgent({
        userId: 'default', // v1: single user
        sessionId,
        history,
        onEvent: (e) => {
          if (!clientGone) send(e);
        },
      });
      full = r.content || '';
    } catch (e) {
      console.error('[openmuse] agent failed:', e.message);
      if (!clientGone) send({ t: 'error', error: 'Agent 执行失败：' + e.message });
    }

    if (full) {
      try {
        await pool.query('INSERT INTO messages (session_id, role, content) VALUES ($1, $2, $3)', [
          sessionId,
          'assistant',
          full,
        ]);
      } catch (e) {
        console.error('[openmuse] save assistant message failed:', e.message);
      }
    }
    if (!clientGone) res.write('data: [DONE]\n\n');
    res.end();
  } catch (e) {
    console.error('[openmuse] /api/chat failed:', e.message);
    if (!res.headersSent) {
      return res.status(500).json({ error: 'internal_error', message: e.message });
    }
    try {
      res.write(`data: ${JSON.stringify({ error: '服务器内部错误' })}\n\n`);
      res.write('data: [DONE]\n\n');
    } catch (_) {}
    res.end();
  }
});

// ---------- sandbox ----------
app.get('/api/sandbox/status', async (req, res) => {
  try {
    const s = await sandboxMgr.getStatus('default');
    if (s.status === 'unconfigured') {
      return res.status(503).json({
        error: 'e2b_not_configured',
        message: 'E2B_API_KEY 未配置，云电脑不可用。请设置环境变量后重启服务。',
      });
    }
    res.json(s);
  } catch (e) {
    res.status(500).json({ error: 'status_failed', message: '查询云电脑状态失败：' + e.message });
  }
});

app.post('/api/sandbox/snapshot', async (req, res) => {
  if (!process.env.E2B_API_KEY) {
    return res.status(503).json({
      error: 'e2b_not_configured',
      message: 'E2B_API_KEY 未配置，云电脑不可用。请设置环境变量后重启服务。',
    });
  }
  try {
    // v2.1: E2B 原生 snapshot 检查点
    const r = await sandboxMgr.createCheckpoint('default');
    res.json(r);
  } catch (e) {
    res.status(500).json({ error: 'snapshot_failed', message: '手动快照失败：' + e.message });
  }
});

app.post('/api/sandbox/pause', async (req, res) => {
  if (!process.env.E2B_API_KEY) {
    return res.status(503).json({
      error: 'e2b_not_configured',
      message: 'E2B_API_KEY 未配置，云电脑不可用。请设置环境变量后重启服务。',
    });
  }
  try {
    const r = await sandboxMgr.pauseSandbox('default');
    res.json(r);
  } catch (e) {
    res.status(500).json({ error: 'pause_failed', message: '暂停云电脑失败：' + e.message });
  }
});

app.post('/api/sandbox/export', async (req, res) => {
  if (!process.env.E2B_API_KEY) {
    return res.status(503).json({
      error: 'e2b_not_configured',
      message: 'E2B_API_KEY 未配置，云电脑不可用。请设置环境变量后重启服务。',
    });
  }
  try {
    // S3 导出层（可移植性），主路径已是 E2B 原生 pause/resume + snapshot
    const r = await sandboxMgr.exportToS3('default');
    res.json(r);
  } catch (e) {
    res.status(500).json({ error: 'export_failed', message: '导出工作区失败：' + e.message });
  }
});

// ---------- static ----------
app.use(express.static(path.join(__dirname, 'static')));
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'not_found' });
  res.sendFile(path.join(__dirname, 'static', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`[openmuse] listening on :${PORT}`);
  initDb().catch((e) => console.error('[openmuse] db init failed (non-fatal):', e.message));
});
