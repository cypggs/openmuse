// openmuse P1 — 后台任务与定时调度器（Worker C）。
//
// 职责：最小 5 字段 cron 解析、计算下一次运行时间、进程内 tick 调度、
// 后台无头执行 agent（runTaskHeadless）。
//
// ⚠ 重要说明（进程内调度）：
// tick 靠本进程的 setInterval 驱动。进程常驻，定时才触发；
// compute 休眠 / 缩容到 0，定时不会触发。
// 若要保证定时可靠，请开 always-on —— 这是用户决策，**不要擅自改**。
'use strict';

const crypto = require('crypto');
const agent = require('./agent');

// ---------------------------------------------------------------------------
// DDL
// ---------------------------------------------------------------------------
const TASKS_DDL = `CREATE TABLE IF NOT EXISTS tasks (
id TEXT PRIMARY KEY,
user_id TEXT NOT NULL,
kind TEXT NOT NULL,
name TEXT NOT NULL,
prompt TEXT NOT NULL,
cron_expr TEXT,
status TEXT NOT NULL DEFAULT 'active',
result TEXT,
next_run_at TIMESTAMPTZ,
last_run_at TIMESTAMPTZ,
created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tasks_status_next_run_idx ON tasks (status, next_run_at);`;

// ---------------------------------------------------------------------------
// pool 管理
// ---------------------------------------------------------------------------
let pool = null; // pg Pool；测试时可注入 mock
let timer = null; // setInterval 句柄
let ticking = false; // tick 防重入：上一次没跑完，不叠加执行

function setPool(p) {
pool = p;
}

// ---------------------------------------------------------------------------
// cron 解析（最小 5 字段，无外部依赖）
// ---------------------------------------------------------------------------
const FIELD_NAMES = ['minute', 'hour', 'dom', 'month', 'dow'];
// 字段范围：分 0-59、时 0-23、日 1-31、月 1-12、周 0-6（7 视为 0，周日）
const FIELD_RANGES = [
[0, 59],
[0, 23],
[1, 31],
[1, 12],
[0, 6],
];

function parseField(raw, min, max, fieldName) {
const set = new Set();
const parts = String(raw).split(',');
for (let part of parts) {
part = part.trim();
if (!part) throw new Error(`cron 表达式字段「${fieldName}」存在空项`);
// 拆出 /step
let base = part;
let step = 1;
const slash = part.indexOf('/');
if (slash >= 0) {
base = part.slice(0, slash);
const s = part.slice(slash + 1);
if (!/^\d+$/.test(s) || Number(s) < 1) {
throw new Error(`cron 表达式字段「${fieldName}」步长非法：${part}`);
}
step = Number(s);
}
let from;
let to;
if (base === '*') {
from = min;
to = max;
} else if (/^\d+$/.test(base)) {
from = Number(base);
to = from;
} else {
const m = base.match(/^(\d+)-(\d+)$/);
if (!m) throw new Error(`cron 表达式字段「${fieldName}」格式非法：${part}`);
from = Number(m[1]);
to = Number(m[2]);
}
// 周字段：7 视为 0（周日）。校验上限放宽到 7，展开时再归一。
const hi = fieldName === 'dow'? 7: max;
if (from < min || to > hi || from > to) {
throw new Error(`cron 表达式字段「${fieldName}」超出范围 ${min}-${hi}：${part}`);
}
for (let v = from; v <= to; v += step) {
set.add(fieldName === 'dow' && v === 7? 0: v);
}
}
if (set.size === 0) throw new Error(`cron 表达式字段「${fieldName}」解析结果为空`);
return set;
}

// parseCron('0 9 * * 1') → { minute:Set, hour:Set, dom:Set, month:Set, dow:Set}
// 支持：*、*/n、a-b、a,b、a-b/n；非法抛中文 Error。
function parseCron(expr) {
if (typeof expr!== 'string') throw new Error('cron 表达式必须是字符串');
const fields = expr.trim().split(/\s+/);
if (fields.length!== 5) {
throw new Error(`cron 表达式必须有 5 个字段（分 时 日 月 周），实际 ${fields.length} 个：${expr}`);
}
const out = {};
for (let i = 0; i < 5; i++) {
out[FIELD_NAMES[i]] = parseField(fields[i], FIELD_RANGES[i][0], FIELD_RANGES[i][1], FIELD_NAMES[i]);
}
return out;
}

// nextRun(expr, fromDate)：从 fromDate 的下一分钟开始逐分钟匹配，上限 366 天。
// dom 与 dow 采用标准 OR 语义：两者都受限时满足其一即可；其一为 * 时只看另一个。
// 返回 Date（本地时区）或 null（366 天内无匹配）。
// 注意：cron 按服务器本地时区解释——容器通常是 UTC，写“每天 9 点”实际是 UTC 9 点
//（北京时间 17 点）。如需用户时区，需在创建任务时换算后再传 cron_expr，v1 暂不自动换算。
function nextRun(expr, fromDate) {
const cron = parseCron(expr);
const start = new Date(fromDate.getTime());
start.setSeconds(0, 0);
start.setMinutes(start.getMinutes() + 1); // cron 最小粒度 1 分钟，从下一分钟开始
const limit = start.getTime() + 366 * 24 * 60 * 60 * 1000;
const domIsStar = cron.dom.size === 31; // 1..31 全覆盖即视为 *
const dowIsStar = cron.dow.size === 7; // 0..6 全覆盖即视为 *
for (let t = start.getTime(); t <= limit; t += 60000) {
const d = new Date(t);
if (!cron.minute.has(d.getMinutes())) continue;
if (!cron.hour.has(d.getHours())) continue;
if (!cron.month.has(d.getMonth() + 1)) continue;
const domMatch = cron.dom.has(d.getDate());
const dowMatch = cron.dow.has(d.getDay());
let dayOk;
if (domIsStar && dowIsStar) dayOk = true;
else if (domIsStar) dayOk = dowMatch;
else if (dowIsStar) dayOk = domMatch;
else dayOk = domMatch || dowMatch; // 都受限：满足其一即可
if (!dayOk) continue;
return d;
}
return null;
}

// ---------------------------------------------------------------------------
// 调度循环
// ---------------------------------------------------------------------------
const RESULT_LIMIT = 20000;

function truncateResult(s) {
s = String(s == null? '': s);
return s.length > RESULT_LIMIT? s.slice(0, RESULT_LIMIT) + '\n…（结果过长，已截断）': s;
}

// 后台无头执行：调 agent.runAgent 跑一次完整 tool loop。
// 注意：**不做长期记忆提取**。后台任务不是实时对话，把它的输出写入
// 长期记忆会污染用户画像（那些话用户并未亲口说过）；结果只存 tasks.result。
async function runTaskHeadless(task) {
let errMsg = '';
const r = await agent.runAgent({
userId: task.user_id,
sessionId: null,
history: [{ role: 'user', content: task.prompt}],
onEvent: (e) => {
if (e && e.t === 'error' &&!errMsg) errMsg = String(e.error || '未知错误');
},
});
const content = r && r.content!= null? String(r.content): '';
if (errMsg) throw new Error(errMsg);
if (!content.trim()) throw new Error('Agent 返回内容为空');
return content;
}

// 执行单个已加锁任务，更新状态/结果/next_run_at。
async function executeTask(task) {
const now = new Date();
let status;
let result;
let nextRunAt = null;
try {
result = await runTaskHeadless(task);
if (task.kind === 'once') {
status = 'done';
} else {
const n = nextRun(task.cron_expr, now);
if (n) {
status = 'active';
nextRunAt = n;
} else {
status = 'failed';
result += `\n按 ${task.cron_expr} 无法计算出下一次运行时间`;
}
}
} catch (e) {
status = 'failed';
result = '任务执行失败：' + (e && e.message? e.message: String(e));
}
try {
await pool.query(
'UPDATE tasks SET status = $1, result = $2, last_run_at = now(), next_run_at = $3 WHERE id = $4',
[status, truncateResult(result), nextRunAt, task.id]
);
} catch (e) {
console.error('[openmuse] scheduler 更新任务状态失败:', e.message);
}
}

// tick：取出到期任务（FOR UPDATE SKIP LOCKED，多实例并发安全），
// 先标记 running 再提交事务，事务外逐个执行（避免长时间持有行锁）。
async function tick() {
if (!pool || ticking) return;
ticking = true;
let client = null;
try {
client = await pool.connect();
await client.query('BEGIN');
const { rows} = await client.query(
`SELECT * FROM tasks
WHERE status = 'active' AND next_run_at <= now()
ORDER BY next_run_at ASC
LIMIT 5
FOR UPDATE SKIP LOCKED`
);
for (const row of rows) {
await client.query('UPDATE tasks SET status = $1 WHERE id = $2', ['running', row.id]);
}
await client.query('COMMIT');
// 事务外执行：单 flight 顺序跑，避免锁持有过久
for (const row of rows) {
await executeTask(row);
}
} catch (e) {
try {
if (client) await client.query('ROLLBACK');
} catch (_) {}
console.error('[openmuse] scheduler tick 失败:', e.message);
} finally {
if (client) client.release();
ticking = false;
}
}

async function startScheduler(p, opts) {
if (p) pool = p;
const intervalMs = (opts && Number(opts.intervalMs)) || 30000;
stopScheduler();
// 恢复上一次非正常退出时卡在 running 的任务，否则它们永远不会再被执行。
// （tick 只取 status='active' 的任务。）
if (pool) {
try {
await pool.query("UPDATE tasks SET status = 'active' WHERE status = 'running'");
} catch (e) {
console.error('[openmuse] scheduler 恢复 running 任务失败:', e.message);
}
}
timer = setInterval(() => {
tick().catch((e) => console.error('[openmuse] scheduler tick 异常:', e.message));
}, intervalMs);
// 启动立即跑一次，把重启期间积压的到期任务补上
tick().catch((e) => console.error('[openmuse] scheduler tick 异常:', e.message));
console.log('[openmuse] scheduler 已启动，间隔', intervalMs, 'ms');
}

function stopScheduler() {
if (timer) {
clearInterval(timer);
timer = null;
}
}

// ---------------------------------------------------------------------------
// 任务创建（供路由与 /api/chat background 分支调用）
// ---------------------------------------------------------------------------
async function createTask({ userId, name, prompt, kind, cron_expr}) {
if (!pool) throw new Error('DATABASE_URL 未配置，无法创建任务');
const k = kind || 'once';
if (k!== 'once' && k!== 'cron') throw new Error('任务类型 kind 必须为 once 或 cron');
const nm = String(name || '').trim();
const pm = String(prompt || '').trim();
if (!nm) throw new Error('任务名称 name 不能为空');
if (!pm) throw new Error('任务内容 prompt 不能为空');
let expr = null;
let nextRunAt = new Date(); // once：立即到期，下一次 tick 执行
if (k === 'cron') {
if (!cron_expr ||!String(cron_expr).trim()) {
throw new Error('cron 任务必须提供合法的 cron_expr');
}
expr = String(cron_expr).trim();
parseCron(expr); // 校验，非法直接抛错
const n = nextRun(expr, new Date());
if (!n) throw new Error('cron 表达式无法计算出下一次运行时间（已耗尽）');
nextRunAt = n;
}
const id = crypto.randomUUID();
const { rows} = await pool.query(
`INSERT INTO tasks (id, user_id, kind, name, prompt, cron_expr, status, next_run_at)
VALUES ($1, $2, $3, $4, $5, $6, 'active', $7)
RETURNING *`,
[id, userId, k, nm, pm, expr, nextRunAt]
);
return rows[0];
}

module.exports = {
TASKS_DDL,
parseCron,
nextRun,
setPool,
startScheduler,
stopScheduler,
tick,
runTaskHeadless,
createTask,
};
