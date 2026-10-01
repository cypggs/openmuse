// openmuse P1 MVP — minimal chat server (Express + pg, no build step).
// Secrets (DEEPSEEK_API_KEY, DATABASE_URL) are read only from process.env
// and are never logged or written anywhere.
'use strict';

const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');
const { toNodeHandler } = require('better-auth/node');
const agent = require('./lib/agent');
const sandboxMgr = require('./lib/sandbox');
const memory = require('./lib/memory');
const authLib = require('./lib/auth');

const PORT = Number(process.env.PORT) || 3000;
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || '';
const DATABASE_URL = process.env.DATABASE_URL || '';

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
  memory.setPool(pool);
} else {
  console.warn('[openmuse] DATABASE_URL 未设置：以无持久化模式运行，会话与消息不会保存');
}
sandboxMgr.startReaper();

const app = express();

// better-auth 路由必须在 express.json() 之前注册（handler 自己处理 body）。
// 没有 DATABASE_URL 时 auth 为 null，/api/auth/* 自然 404，服务降级为单用户开发模式。
if (pool) authLib.initAuth(pool);
const auth = authLib.getAuth();
if (auth) {
  app.all('/api/auth/*', toNodeHandler(auth));
}

app.use(express.json({ limit: '1mb' }));

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
  // v1.1: 长期记忆
  await pool.query(`CREATE TABLE IF NOT EXISTS memories (
    id SERIAL PRIMARY KEY,
    user_id TEXT NOT NULL,
    type TEXT NOT NULL,
    content TEXT NOT NULL,
    importance INT DEFAULT 3,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
  )`);
  await pool.query(
    `CREATE INDEX IF NOT EXISTS memories_user_importance_idx ON memories (user_id, importance DESC, updated_at DESC)`
  );
  // 登录与多用户：sessions 增加 user_id（旧数据归 'default'）
  await pool.query(`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS user_id TEXT`);
  await pool.query(`UPDATE sessions SET user_id = 'default' WHERE user_id IS NULL`);
  await pool.query(
    `CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON sessions (user_id, created_at DESC)`
  );
  // better-auth 表（user / session / account / verification，均为单数，与
  // 现有的聊天 sessions（复数）表不冲突）。表名/列名取自 better-auth 1.7.7
  // 默认 schema（id text 主键，string→text，boolean→boolean，date→timestamptz）。
  await pool.query(`CREATE TABLE IF NOT EXISTS "user" (
    "id" text NOT NULL PRIMARY KEY,
    "name" text NOT NULL,
    "email" text NOT NULL UNIQUE,
    "emailVerified" boolean NOT NULL,
    "image" text,
    "createdAt" timestamptz NOT NULL,
    "updatedAt" timestamptz NOT NULL
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS "session" (
    "id" text NOT NULL PRIMARY KEY,
    "expiresAt" timestamptz NOT NULL,
    "token" text NOT NULL UNIQUE,
    "createdAt" timestamptz NOT NULL,
    "updatedAt" timestamptz NOT NULL,
    "ipAddress" text,
    "userAgent" text,
    "userId" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS "account" (
    "id" text NOT NULL PRIMARY KEY,
    "accountId" text NOT NULL,
    "providerId" text NOT NULL,
    "userId" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
    "accessToken" text,
    "refreshToken" text,
    "idToken" text,
    "accessTokenExpiresAt" timestamptz,
    "refreshTokenExpiresAt" timestamptz,
    "scope" text,
    "password" text,
    "createdAt" timestamptz NOT NULL,
    "updatedAt" timestamptz NOT NULL
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS "verification" (
    "id" text NOT NULL PRIMARY KEY,
    "identifier" text NOT NULL,
    "value" text NOT NULL,
    "expiresAt" timestamptz NOT NULL,
    "createdAt" timestamptz NOT NULL,
    "updatedAt" timestamptz NOT NULL
  )`);
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

// 登录守卫：启用登录时要求有效 session；未启用时走单用户开发模式（userId='default'）。
const requireUser = authLib.requireUser();

// ---------- api ----------
app.get('/api/health', (req, res) => res.json({ ok: true }));

app.get('/api/auth-config', (req, res) => {
  res.json({ authEnabled: authLib.isAuthEnabled(), providers: authLib.authProviders() });
});

app.get('/api/sessions', requireDb, requireUser, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `
      SELECT s.id, s.title, s.created_at
      FROM sessions s
      LEFT JOIN messages m ON m.session_id = s.id
      WHERE s.user_id = $1
      GROUP BY s.id
      ORDER BY COALESCE(MAX(m.created_at), s.created_at) DESC
    `,
      [req.userId]
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: 'db_error', message: e.message });
  }
});

app.post('/api/sessions', requireDb, requireUser, async (req, res) => {
  try {
    const id = crypto.randomUUID();
    const title = (req.body && typeof req.body.title === 'string' && req.body.title.trim()) || '新的对话';
    await pool.query('INSERT INTO sessions (id, title, user_id) VALUES ($1, $2, $3)', [
      id,
      title,
      req.userId,
    ]);
    res.json({ id });
  } catch (e) {
    res.status(500).json({ error: 'db_error', message: e.message });
  }
});

app.get('/api/sessions/:id/messages', requireDb, requireUser, async (req, res) => {
  try {
    const owner = await pool.query('SELECT id FROM sessions WHERE id = $1 AND user_id = $2', [
      req.params.id,
      req.userId,
    ]);
    if (owner.rowCount === 0) {
      return res.status(404).json({ error: 'not_found', message: '会话不存在' });
    }
    const { rows } = await pool.query(
      'SELECT role, content, created_at FROM messages WHERE session_id = $1 ORDER BY id ASC',
      [req.params.id]
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: 'db_error', message: e.message });
  }
});

app.delete('/api/sessions/:id', requireDb, requireUser, async (req, res) => {
  try {
    const r = await pool.query('DELETE FROM sessions WHERE id = $1 AND user_id = $2', [
      req.params.id,
      req.userId,
    ]);
    if (r.rowCount === 0) return res.status(404).json({ error: 'not_found', message: '会话不存在' });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'db_error', message: e.message });
  }
});

app.post('/api/chat', requireDb, requireUser, async (req, res) => {
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
    // Ensure session exists and belongs to this user (create on demand).
    let sessionExists = false;
    if (sessionId) {
      const s = await pool.query('SELECT id FROM sessions WHERE id = $1 AND user_id = $2', [
        sessionId,
        req.userId,
      ]);
      sessionExists = s.rowCount > 0;
    }
    if (!sessionExists) {
      sessionId = crypto.randomUUID();
      const title = Array.from(message).slice(0, 24).join('') || '新的对话';
      await pool.query('INSERT INTO sessions (id, title, user_id) VALUES ($1, $2, $3)', [
        sessionId,
        title,
        req.userId,
      ]);
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

    // v1.1: 长期记忆注入 system prompt（无记忆时不注入该块）
    let systemExtra = '';
    try {
      const mems = await memory.getMemories(req.userId, 20);
      const block = memory.formatMemoryBlock(mems);
      if (block) {
        systemExtra =
          '\n\n<长期记忆>\n以下是关于这位用户的长期记忆，可在回答中自然参考，不要逐字复述，除非用户问起：\n' +
          block +
          '\n</长期记忆>';
      }
    } catch (e) {
      console.error('[openmuse] get memories failed:', e.message);
    }

    let full = '';
    try {
      const r = await agent.runAgent({
        userId: req.userId,
        sessionId,
        history,
        systemExtra,
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

    // v1.1: 长期记忆提取（fire-and-forget，异常只打日志）
    // 条件：本 session 用户消息>=2 条且最后一条用户消息长度>15，避免噪音
    if (full && DEEPSEEK_API_KEY) {
      try {
        const userMsgs = history.filter((m) => m.role === 'user');
        const lastUser = userMsgs[userMsgs.length - 1];
        const lastLen = lastUser ? String(lastUser.content || '').length : 0;
        console.log('[openmuse] memory extraction check:', {
          userMsgs: userMsgs.length,
          lastLen,
          fullLen: full.length,
        });
        if (userMsgs.length >= 2 && lastLen > 15) {
          const recent = [...history.slice(-11), { role: 'assistant', content: full }];
          memory
            .extractMemories(req.userId, recent)
            .then((items) => {
              console.log('[openmuse] memory extraction done:', items.length, 'items');
            })
            .catch((e) => {
              console.error('[openmuse] memory extraction error:', e && e.message);
            });
        }
      } catch (e) {
        console.error('[openmuse] memory extraction error:', e && e.message);
      }
    }
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
app.get('/api/sandbox/status', requireUser, async (req, res) => {
  try {
    const s = await sandboxMgr.getStatus(req.userId);
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

app.post('/api/sandbox/snapshot', requireUser, async (req, res) => {
  if (!process.env.E2B_API_KEY) {
    return res.status(503).json({
      error: 'e2b_not_configured',
      message: 'E2B_API_KEY 未配置，云电脑不可用。请设置环境变量后重启服务。',
    });
  }
  try {
    // v2.1: E2B 原生 snapshot 检查点
    const r = await sandboxMgr.createCheckpoint(req.userId);
    res.json(r);
  } catch (e) {
    res.status(500).json({ error: 'snapshot_failed', message: '手动快照失败：' + e.message });
  }
});

app.post('/api/sandbox/pause', requireUser, async (req, res) => {
  if (!process.env.E2B_API_KEY) {
    return res.status(503).json({
      error: 'e2b_not_configured',
      message: 'E2B_API_KEY 未配置，云电脑不可用。请设置环境变量后重启服务。',
    });
  }
  try {
    const r = await sandboxMgr.pauseSandbox(req.userId);
    res.json(r);
  } catch (e) {
    res.status(500).json({ error: 'pause_failed', message: '暂停云电脑失败：' + e.message });
  }
});

app.post('/api/sandbox/export', requireUser, async (req, res) => {
  if (!process.env.E2B_API_KEY) {
    return res.status(503).json({
      error: 'e2b_not_configured',
      message: 'E2B_API_KEY 未配置，云电脑不可用。请设置环境变量后重启服务。',
    });
  }
  try {
    // S3 导出层（可移植性），主路径已是 E2B 原生 pause/resume + snapshot
    const r = await sandboxMgr.exportToS3(req.userId);
    res.json(r);
  } catch (e) {
    res.status(500).json({ error: 'export_failed', message: '导出工作区失败：' + e.message });
  }
});

// ---------- memories (长期记忆 v1.1) ----------
app.get('/api/memories', requireDb, requireUser, async (req, res) => {
  try {
    res.json(await memory.listMemories(req.userId));
  } catch (e) {
    res.status(500).json({ error: 'db_error', message: e.message });
  }
});

app.delete('/api/memories/:id', requireDb, requireUser, async (req, res) => {
  try {
    const n = await memory.deleteMemory(req.userId, req.params.id);
    if (!n) return res.status(404).json({ error: 'not_found', message: '记忆不存在' });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'db_error', message: e.message });
  }
});

// ---------- static ----------
app.use(express.static(path.join(__dirname, 'static')));
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'not_found' });
  res.sendFile(path.join(__dirname, 'static', 'index.html'));
});

async function boot() {
  // DB (含 better-auth 表) 必须在 listen 之前就绪，否则 /api/auth/* 会因 SCHEMA_MISMATCH 致命崩溃
  await initDb();
  app.listen(PORT, () => {
    console.log(`[openmuse] listening on :${PORT}`);
  });
}
boot().catch((e) => {
  console.error('[openmuse] boot failed:', e.message);
  process.exit(1);
});
