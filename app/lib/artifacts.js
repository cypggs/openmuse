// openmuse P1 Worker B — Artifacts 画布。
//
// 模型可用 tool 创建富内容（html / markdown / svg / code），持久化到 postgres；
// 前端通过 CustomEvent('openmuse:artifact') + REST 拉取并在右侧画布渲染。
// 安全红线：html 渲染一律用 <iframe sandbox="allow-scripts" srcdoc=...>，
// 绝不加 allow-same-origin（opaque origin，防 XSS）。
'use strict';

const crypto = require('crypto');

// 内容上限：500KB（字符数）
const MAX_CONTENT_CHARS = 512000;

// 合法的 artifact 类型
const ARTIFACT_TYPES = ['html', 'markdown', 'svg', 'code'];

const ARTIFACTS_DDL = `
CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  session_id TEXT,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS artifacts_user_updated_idx ON artifacts (user_id, updated_at DESC);
`.trim();

let pool = null;

function setPool(p) {
  pool = p || null;
}

function mustPool() {
  if (!pool) throw new Error('数据库未配置，artifact 功能不可用');
}

function assertType(type) {
  if (!ARTIFACT_TYPES.includes(type)) {
    throw new Error('不支持的 artifact 类型：' + type + '（仅支持 ' + ARTIFACT_TYPES.join('、') + '）');
  }
}

function assertContent(content) {
  const s = String(content == null ? '' : content);
  if (s.length > MAX_CONTENT_CHARS) {
    throw new Error('内容过大：' + s.length + ' 字符，超过 500KB 上限');
  }
  return s;
}

async function createArtifact({ userId, sessionId, title, type, content }) {
  assertType(type);
  const body = assertContent(content);
  mustPool();
  const id = crypto.randomUUID();
  const { rows } = await pool.query(
    `INSERT INTO artifacts (id, user_id, session_id, type, title, content)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [id, userId, sessionId || null, type, String(title || '未命名'), body]
  );
  return rows[0];
}

async function getArtifact(userId, id) {
  mustPool();
  const { rows } = await pool.query(
    `SELECT * FROM artifacts WHERE id = $1 AND user_id = $2`,
    [id, userId]
  );
  return rows[0] || null;
}

async function listArtifacts(userId, sessionId) {
  mustPool();
  if (sessionId) {
    const { rows } = await pool.query(
      `SELECT id, user_id, session_id, type, title,
              substr(content, 1, 200) AS preview,
              created_at, updated_at
       FROM artifacts WHERE user_id = $1 AND session_id = $2
       ORDER BY updated_at DESC`,
      [userId, sessionId]
    );
    return rows;
  }
  const { rows } = await pool.query(
    `SELECT id, user_id, session_id, type, title,
            substr(content, 1, 200) AS preview,
            created_at, updated_at
     FROM artifacts WHERE user_id = $1
     ORDER BY updated_at DESC`,
    [userId]
  );
  return rows;
}

async function updateArtifact(userId, id, content) {
  const body = assertContent(content);
  mustPool();
  const { rows } = await pool.query(
    `UPDATE artifacts SET content = $1, updated_at = now()
     WHERE id = $2 AND user_id = $3
     RETURNING *`,
    [body, id, userId]
  );
  return rows[0] || null;
}

async function deleteArtifact(userId, id) {
  mustPool();
  const r = await pool.query(`DELETE FROM artifacts WHERE id = $1 AND user_id = $2`, [id, userId]);
  return r.rowCount;
}

// ---------- Agent tools（OpenAI function 格式） ----------

const ARTIFACT_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'create_artifact',
      description:
        '创建可视化内容并在右侧画布中打开。当用户需要网页、报告、图表、演示页面、代码展示或文档时使用。html 必须是完整可运行的单文件（内联 CSS/JS）。创建成功后用一句话告诉用户已在右侧画布打开，不要把大段 html 贴进聊天正文。',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'artifact 标题' },
          type: {
            type: 'string',
            enum: ['html', 'markdown', 'svg', 'code'],
            description: '内容类型：html（可交互网页）、markdown（文档）、svg（矢量图）、code（代码展示）',
          },
          content: { type: 'string', description: '完整内容，最大 500KB' },
        },
        required: ['title', 'type', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_artifact',
      description: '更新已有 artifact 的内容。content 为替换后的完整内容（不是 diff）。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'artifact 的 id' },
          content: { type: 'string', description: '替换后的完整内容，最大 500KB' },
        },
        required: ['id', 'content'],
      },
    },
  },
];

// ---------- executor ----------

async function executeCreateArtifact(args, ctx) {
  try {
    const row = await createArtifact({
      userId: ctx.userId,
      sessionId: ctx.sessionId,
      title: args.title,
      type: args.type,
      content: args.content,
    });
    return {
      ok: true,
      output: 'artifact 已创建并在右侧画布打开：' + row.title + '（' + row.type + '，id=' + row.id + '）',
      artifact: { id: row.id, title: row.title, type: row.type },
    };
  } catch (e) {
    return { ok: false, output: '创建失败：' + (e && e.message ? e.message : String(e)) };
  }
}

async function executeUpdateArtifact(args, ctx) {
  try {
    const row = await updateArtifact(ctx.userId, args.id, args.content);
    if (!row) return { ok: false, output: '更新失败：artifact 不存在' };
    return {
      ok: true,
      output: 'artifact 已更新：' + row.title + '（id=' + row.id + '）',
      artifact: { id: row.id, title: row.title, type: row.type },
    };
  } catch (e) {
    return { ok: false, output: '更新失败：' + (e && e.message ? e.message : String(e)) };
  }
}

// ---------- 追加到 SYSTEM_PROMPT 的文本 ----------

const ARTIFACT_PROMPT =
  '当用户想要网页、报告、图表、演示页面、代码展示或文档时，使用 create_artifact 工具创建可视化内容：' +
  'html 类型必须是完整可运行的单文件（内联 CSS/JS，不依赖外部资源）；' +
  '创建成功后用一句话告诉用户已在右侧画布打开，绝不要把大段 html 粘贴进聊天正文；' +
  '如需修改已有内容，调用 update_artifact。';

module.exports = {
  setPool,
  ARTIFACTS_DDL,
  ARTIFACT_TYPES,
  MAX_CONTENT_CHARS,
  createArtifact,
  getArtifact,
  listArtifacts,
  updateArtifact,
  deleteArtifact,
  ARTIFACT_TOOLS,
  executeCreateArtifact,
  executeUpdateArtifact,
  ARTIFACT_PROMPT,
};
