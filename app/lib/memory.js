// openmuse v1.1 — 长期记忆系统 (long-term memory).
//
// Flow: after each chat turn completes (fire-and-forget), deepseek-chat
// extracts candidate memories from recent messages; each is upserted into
// the `memories` table with substring-based dedup. On the next /api/chat,
// getMemories() results are injected into the system prompt.
//
// v1 has NO vector dependency: retrieval is importance + recency ranking.
// pgvector semantic search is the planned v2 upgrade.
//
// Secrets are read only from process.env and are never logged.
'use strict';

const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || '';
const DEEPSEEK_URL = 'https://api.deepseek.com/v1/chat/completions';
const MODEL = 'deepseek-chat'; // 便宜的提取模型，与 agent 主循环一致

const MEMORY_TYPES = ['fact', 'preference', 'project', 'relationship', 'decision'];

const EXTRACT_PROMPT =
  '你是长期记忆提取器。从以下对话中提取值得长期记住的信息：用户的事实、偏好、项目进展、人际关系、做出的决定。' +
  '每条一句话，用中文表述。importance 1-5（5=非常重要，如用户姓名、核心偏好；1=弱信息）。' +
  'type 只能取值 fact/preference/project/relationship/decision。' +
  '只返回 JSON 数组，例如 [{"type":"fact","content":"用户叫张三，是后端工程师","importance":5}]。' +
  '没有值得记的信息返回 []。不要输出 markdown，不要解释。';

// ---- pool (set by server.js, same pattern as lib/sandbox) ----
let pool = null;
function setPool(p) {
  pool = p;
}

// 容错：模型返回被 ```json fence 包裹时剥离；纯文本直接返回
function stripMarkdownFence(s) {
  s = String(s == null ? '' : s).trim();
  const m = s.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return m ? m[1].trim() : s;
}

// 校验 + 归一化模型输出；丢弃过短（<=8 字符）的噪音条目
function sanitizeItems(arr) {
  if (!Array.isArray(arr)) return [];
  return arr
    .filter((it) => it && typeof it === 'object')
    .map((it) => ({
      type: MEMORY_TYPES.includes(it.type) ? it.type : 'fact',
      content: String(it.content || '').trim(),
      importance: Math.min(5, Math.max(1, Math.round(Number(it.importance)) || 3)),
    }))
    .filter((it) => it.content.length > 8);
}

// 去重 upsert：新 content 与已有某条互相包含（任一方向）→ UPDATE 那条
// （content 取两者较长的以免丢信息，importance 取 max，updated_at=now）；
// 否则 INSERT。
async function upsertMemory(userId, item) {
  const { rows } = await pool.query('SELECT id, content, importance FROM memories WHERE user_id = $1', [
    userId,
  ]);
  const content = item.content;
  for (const r of rows) {
    const old = String(r.content || '');
    if (old.includes(content) || content.includes(old)) {
      await pool.query(
        'UPDATE memories SET content = $1, importance = GREATEST(importance, $2), updated_at = now() WHERE id = $3',
        [content.length >= old.length ? content : old, item.importance, r.id]
      );
      return { action: 'updated', id: r.id };
    }
  }
  await pool.query('INSERT INTO memories (user_id, type, content, importance) VALUES ($1, $2, $3, $4)', [
    userId,
    item.type,
    content,
    item.importance,
  ]);
  return { action: 'inserted' };
}

// 从最近对话中提取记忆（fire-and-forget 由 server.js 触发；内部已吞异常）
async function extractMemories(userId, recentMessages) {
  if (!DEEPSEEK_API_KEY || !pool) return [];
  const conv = (recentMessages || [])
    .map((m) => `${m.role === 'user' ? '用户' : '助手'}：${String(m.content || '').slice(0, 500)}`)
    .join('\n');
  if (!conv.trim()) return [];

  let text = '';
  try {
    const res = await fetch(DEEPSEEK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + DEEPSEEK_API_KEY,
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: 'system', content: EXTRACT_PROMPT },
          { role: 'user', content: conv },
        ],
        temperature: 0.3,
      }),
    });
    if (!res.ok) throw new Error('status ' + res.status);
    const j = await res.json();
    text = (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';
  } catch (e) {
    console.error('[openmuse] memory extraction failed:', e.message);
    return [];
  }

  let items;
  try {
    items = JSON.parse(stripMarkdownFence(text));
  } catch (_) {
    console.error('[openmuse] memory extraction: model returned non-JSON');
    return [];
  }

  const clean = sanitizeItems(items);
  for (const it of clean) {
    try {
      await upsertMemory(userId, it);
    } catch (e) {
      console.error('[openmuse] memory upsert failed:', e.message);
    }
  }
  return clean;
}

// 按 importance DESC, updated_at DESC 取记忆（v1 检索：排序，无向量）
async function getMemories(userId, limit = 20) {
  if (!pool) return [];
  const { rows } = await pool.query(
    `SELECT id, type, content, importance, created_at, updated_at
     FROM memories WHERE user_id = $1
     ORDER BY importance DESC, updated_at DESC LIMIT $2`,
    [userId, Math.max(1, Math.min(200, Number(limit) || 20))]
  );
  return rows;
}

async function listMemories(userId) {
  return getMemories(userId, 100);
}

// 只能删除自己的记忆（user_id 过滤；跨用户 id 返回 0 → 404）
async function deleteMemory(userId, id) {
  if (!pool) return 0;
  const r = await pool.query('DELETE FROM memories WHERE id = $1 AND user_id = $2', [id, userId]);
  return r.rowCount;
}

// system prompt 注入块：每条 "- [type] content"；无记忆时返回 ''（不注入）
function formatMemoryBlock(rows) {
  if (!rows || !rows.length) return '';
  return rows.map((m) => `- [${m.type}] ${m.content}`).join('\n');
}

module.exports = {
  setPool,
  extractMemories,
  getMemories,
  listMemories,
  deleteMemory,
  upsertMemory,
  formatMemoryBlock,
  MEMORY_TYPES,
  // 导出供单元测试（_ 前缀表内部）
  _stripMarkdownFence: stripMarkdownFence,
  _sanitizeItems: sanitizeItems,
};
