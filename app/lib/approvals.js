// openmuse P0 — 审批机制（Approval）。
//
// 设计（见 docs/browser-vault-design.md §3）：
// - 敏感操作（凭证填入、敏感站点导航、下载、表单提交…）必须经过用户审批。
// - 用户侧：审批卡片（允许一次 / 始终允许此站点 / 拒绝）。
// - 系统侧：15 分钟过期；每次决定写审计日志；"始终允许"进 standing_grants。
//
// 安全红线：detail 只放脱敏信息（域名、掩码用户名），永不放凭证值。
'use strict';

const crypto = require('crypto');

const DEFAULT_TTL_MS = 15 * 60 * 1000;

// ---------- in-memory pub/sub ----------
// approvalId -> { resolve, timer }：任务挂起等待用户决定。
const waiters = new Map();
// userId -> Set<res>：SSE 长连接推送。
const sseClients = new Map();

function newId() {
  return crypto.randomUUID();
}

/**
 * 创建一条审批请求。返回 approval 行（含 id）。
 * 调用方随后通常会 await waitForDecision(id) 挂起任务。
 */
async function createApproval(pool, { userId, sessionId, kind, title, detail, ttlMs }) {
  const id = newId();
  const expiresAt = new Date(Date.now() + (ttlMs || DEFAULT_TTL_MS));
  // detail 做一次脱敏检查：禁止出现疑似凭证值的长字符串字段
  const safeDetail = sanitizeDetail(detail || {});
  const { rows } = await pool.query(
    `INSERT INTO approvals (id, user_id, session_id, kind, title, detail, status, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7)
     RETURNING id, user_id, session_id, kind, title, detail, status, created_at, expires_at`,
    [id, userId, sessionId || null, kind, title, JSON.stringify(safeDetail), expiresAt]
  );
  const approval = rows[0];
  pushToUser(userId, { t: 'approval', approval: publicView(approval) });
  return approval;
}

// 脱敏：detail 里不允许出现 password / passwd / secret / token / key 命名的字段，
// 也不允许单个字符串值超过 200 字符（防误塞）。
function sanitizeDetail(detail) {
  const out = {};
  for (const [k, v] of Object.entries(detail)) {
    if (/password|passwd|secret|token|api[_-]?key|credential/i.test(k)) continue;
    if (typeof v === 'string' && v.length > 200) {
      out[k] = v.slice(0, 200) + '…(truncated)';
      continue;
    }
    out[k] = v;
  }
  return out;
}

// 给前端的公开视图（字段白名单）
function publicView(row) {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    detail: typeof row.detail === 'string' ? JSON.parse(row.detail) : row.detail,
    status: row.status,
    created_at: row.created_at,
    expires_at: row.expires_at,
  };
}

/**
 * 用户决定。decision: 'allow_once' | 'allow_always' | 'deny'。
 * 返回 { approval, decision }。幂等：已决定的审批再次 decide 返回原状态。
 */
async function decideApproval(pool, { id, userId, decision }) {
  if (!['allow_once', 'allow_always', 'deny'].includes(decision)) {
    throw new Error('decision 非法');
  }
  const { rows } = await pool.query(
    'SELECT * FROM approvals WHERE id = $1 AND user_id = $2',
    [id, userId]
  );
  const row = rows[0];
  if (!row) throw new Error('审批不存在');
  if (row.status !== 'pending') {
    return { approval: publicView(row), decision: row.status, already: true };
  }
  if (new Date(row.expires_at) < new Date()) {
    await pool.query(`UPDATE approvals SET status = 'expired', decided_at = now() WHERE id = $1`, [id]);
    notifyDecision(id, 'expired');
    pushToUser(userId, { t: 'approval_decided', id, decision: 'expired' });
    return { approval: publicView({ ...row, status: 'expired' }), decision: 'expired' };
  }

  const finalStatus = decision === 'deny' ? 'denied' : 'approved';
  await pool.query(
    `UPDATE approvals SET status = $1, decided_at = now() WHERE id = $2`,
    [finalStatus, id]
  );
  // allow_always → standing_grants（scope 从 detail 取）
  let grantScope = null;
  if (decision === 'allow_always') {
    const detail = typeof row.detail === 'string' ? JSON.parse(row.detail) : row.detail;
    grantScope = { scope_kind: row.kind, scope_value: String(detail.site || detail.domain || '*') };
    await pool.query(
      `INSERT INTO standing_grants (user_id, scope_kind, scope_value)
       VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      [userId, grantScope.scope_kind, grantScope.scope_value]
    );
  }
  // 审计（不记值，只记元数据）
  const detail = typeof row.detail === 'string' ? JSON.parse(row.detail) : row.detail;
  await pool.query(
    `INSERT INTO approval_audit (approval_id, user_id, kind, site, decision)
     VALUES ($1, $2, $3, $4, $5)`,
    [id, userId, row.kind, String(detail.site || detail.domain || ''), decision]
  );

  notifyDecision(id, decision);
  pushToUser(userId, { t: 'approval_decided', id, decision });
  const updated = { ...row, status: finalStatus };
  return { approval: publicView(updated), decision };
}

/** 查询用户待处理的审批（前端加载时用） */
async function pendingApprovals(pool, userId) {
  await expireStale(pool, userId);
  const { rows } = await pool.query(
    `SELECT * FROM approvals WHERE user_id = $1 AND status = 'pending' ORDER BY created_at DESC`,
    [userId]
  );
  return rows.map(publicView);
}

/** 检查 standing grant */
async function checkGrant(pool, { userId, scopeKind, scopeValue }) {
  const { rows } = await pool.query(
    `SELECT 1 FROM standing_grants WHERE user_id = $1 AND scope_kind = $2 AND scope_value = $3`,
    [userId, scopeKind, scopeValue]
  );
  return rows.length > 0;
}

/** 把过期未决的标记为 expired */
async function expireStale(pool, userId) {
  const { rows } = await pool.query(
    `UPDATE approvals SET status = 'expired', decided_at = now()
     WHERE user_id = $1 AND status = 'pending' AND expires_at < now()
     RETURNING id`,
    [userId]
  );
  for (const r of rows) {
    notifyDecision(r.id, 'expired');
    pushToUser(userId, { t: 'approval_decided', id: r.id, decision: 'expired' });
  }
  return rows.length;
}

/**
 * 挂起等待用户决定。resolve 值为 'allow_once' | 'allow_always' | 'deny' | 'expired'。
 * 超时（默认 16 分钟，略大于审批 TTL）后按 'expired' 处理。
 */
function waitForDecision(approvalId, timeoutMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      waiters.delete(approvalId);
      resolve('expired');
    }, timeoutMs || DEFAULT_TTL_MS + 60 * 1000);
    waiters.set(approvalId, {
      resolve: (d) => {
        clearTimeout(timer);
        waiters.delete(approvalId);
        resolve(d);
      },
    });
  });
}

function notifyDecision(approvalId, decision) {
  const w = waiters.get(approvalId);
  if (w) w.resolve(decision);
}

// ---------- SSE 推送 ----------

function addSseClient(userId, res) {
  if (!sseClients.has(userId)) sseClients.set(userId, new Set());
  sseClients.get(userId).add(res);
}

function removeSseClient(userId, res) {
  const set = sseClients.get(userId);
  if (set) {
    set.delete(res);
    if (set.size === 0) sseClients.delete(userId);
  }
}

function pushToUser(userId, event) {
  const set = sseClients.get(String(userId));
  if (!set) return;
  const data = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of set) {
    try {
      res.write(data);
    } catch (_) {
      // 写失败的连接由 close 事件清理
    }
  }
}

module.exports = {
  createApproval,
  decideApproval,
  pendingApprovals,
  checkGrant,
  expireStale,
  waitForDecision,
  addSseClient,
  removeSseClient,
  pushToUser,
  publicView,
  DEFAULT_TTL_MS,
};
