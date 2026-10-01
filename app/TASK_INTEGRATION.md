# TASK_INTEGRATION.md — 后台任务与定时（Worker C 交付物集成说明）

> 给 coordinator：本文件说明如何把 Worker C 的 4 个新文件接入现有代码。
> **只新增代码行，不改动任何现有逻辑。** 建议按下面的顺序粘贴。

## ⚠ 先读：进程内调度的约束（必须保留）

`lib/scheduler.js` 的 tick 靠本进程 `setInterval` 驱动：

- **进程常驻 → 定时触发；compute 休眠 / 缩容到 0 → 定时不触发。**
- 要保证定时可靠，请开 **always-on** —— 这是**用户决策**，运维/代码层**不要擅自改**。
- 同一约束已写在 `lib/scheduler.js` 和 `lib/taskRoutes.js` 的顶部注释里；对外文档如需提及请保留原意。

## 交付文件一览（均已 `node --check`，测试 23/23 通过）

| 文件 | 说明 |
|---|---|
| `lib/scheduler.js` | cron 解析 + 调度器（`TASKS_DDL`、`parseCron`、`nextRun`、`tick`、`runTaskHeadless`、`createTask`、`startScheduler/stopScheduler`、`setPool`） |
| `lib/taskRoutes.js` | `registerTaskRoutes(app, {pool, requireUser})`：任务 CRUD + 手动触发 |
| `static/task-panel.js` | 自包含前端面板（topbar「任务」按钮、右侧抽屉、composer「后台运行」checkbox、`window.openmuseTasks`） |
| `test/scheduler.test.js` | `node test/scheduler.test.js` → `scheduler tests: 23/23 passed` |

---

## ① server.js 接线

### 1.1 顶部 require（与现有 require 放一起）

```js
const scheduler = require('./lib/scheduler');
const { registerTaskRoutes } = require('./lib/taskRoutes');
```

### 1.2 pool 就绪后注入（放在现有 `sandboxMgr.setPool(pool); memory.setPool(pool);` 旁边）

```js
scheduler.setPool(pool);
```

### 1.3 initDb 末尾建表（放在 `console.log('[openmuse] database ready')` 之前）

```js
// P1 后台任务表
await pool.query(scheduler.TASKS_DDL);
```

> 注意：`TASKS_DDL` 是一个字符串，内含两条语句（`CREATE TABLE IF NOT EXISTS tasks …;` + `CREATE INDEX IF NOT EXISTS …`）。
> pg 的 `pool.query` 支持多语句一次发送，这里两条都是 `IF NOT EXISTS`，幂等安全。
> 如未来迁移到不支持多语句的驱动，拆成两次 `pool.query` 即可（按 `;` 切分）。

### 1.4 注册任务路由（放在 `// ---------- memories` 路由段之后、`// ---------- static` 之前）

```js
// P1 后台任务 CRUD（Worker C；pool 为 null 时路由内返回 503）
if (pool) registerTaskRoutes(app, { pool, requireUser });
```

> `registerTaskRoutes` 内部还会再调一次 `scheduler.setPool(pool)`（防御性，幂等），
> 即使 1.2 漏了也不影响。

### 1.5 boot() 里启动调度器（`await initDb()` 之后、`app.listen` 之前或之后均可）

```js
async function boot() {
  // DB (含 better-auth 表) 必须在 listen 之前就绪，否则 /api/auth/* 会因 SCHEMA_MISMATCH 致命崩溃
  await initDb();
  if (pool) scheduler.startScheduler(pool); // P1 后台任务 tick（intervalMs 默认 30000）
  app.listen(PORT, () => {
    console.log(`[openmuse] listening on :${PORT}`);
  });
}
```

---

## ② `/api/chat` 改造：background 分支

**插入位置**：现有 `app.post('/api/chat', …)` 回调开头，在
`if (!message) { … empty_message … }` 非空校验**之后**、
`if (!DEEPSEEK_API_KEY) { … llm_not_configured … }` 检查**之前**。

**粘贴代码块**（直接 return JSON，不走 SSE）：

```js
// P1 后台任务：前端勾选「后台运行」时，只创建 once 任务并立即返回 task_id，
// 不走 SSE、不创建聊天 session、不写 messages、不做记忆提取。
if (body.background === true) {
  try {
    const bgName = Array.from(message).slice(0, 20).join('') || '后台任务';
    const task = await scheduler.createTask({
      userId: req.userId,
      name: bgName,
      prompt: message,
      kind: 'once',
    });
    return res.json({ task_id: task.id });
  } catch (e) {
    return res.status(400).json({ error: 'task_create_failed', message: e.message });
  }
}
```

要点：

- 该分支在 `requireDb` + `requireUser` 之后，所以 `req.userId` 可用、无 DB 时已 503。
- 任务名取 message 前 20 字（按 Unicode 码点截断，避免 emoji 截半）。
- `kind: 'once'` → `next_run_at = now()`，下一次 tick（≤30s）即执行。
- 返回 `{ task_id }`，前端 `window.openmuseTasks.submitBackground` 负责在聊天区插系统提示。

---

## ③ index.html 接线

### 3.1 引入面板脚本（`</body>` 之前，与主内联 `<script>` 同级）

```html
<script src="/task-panel.js"></script>
```

> 必须放在主内联脚本**之后**（面板脚本自包含、延迟到 DOMContentLoaded 启动，
> 但 `window.openmuseTasks` 要在 doSend 可能被调用前就绪——脚本在内联之后加载即满足）。

### 3.2 doSend 接线（不要改写 doSend，只加 4 行）

**插入位置**：`doSend()` 函数开头，在 `addUserMsg(text); inputEl.value='';` 之后、
`fetch('/api/chat', …)` 之前。注意此时 input 已清空，必须用局部变量 `text`。

**粘贴代码块**：

```js
// P1 后台运行：勾选时只提交任务，不走 SSE
if (window.openmuseTasks && window.openmuseTasks.isBackground()) {
  await window.openmuseTasks.submitBackground(text);
  setBusy(false);
  return;
}
```

完整上下文示意（仅用于定位，不要整段替换）：

```js
async function doSend(){
  var text=inputEl.value.trim();
  if(!text||streaming) return;
  if(innerEl.querySelector('.empty')) clearMsgs();
  addUserMsg(text);inputEl.value='';autosize();setBusy(true);
  // ★ 插在这里
  if (window.openmuseTasks && window.openmuseTasks.isBackground()) {
    await window.openmuseTasks.submitBackground(text);
    setBusy(false);
    return;
  }
  var body=addTyping(), raw='', sid=null, finished=false;
  …
```

> `submitBackground` 内部已处理成功/失败的系统提示插入并返回 task_id（失败返回 null），
> doSend 侧无需再处理返回值。

---

## API 速览（供联调）

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/tasks` | body `{name, prompt, kind='once', cron_expr?}` → 201 任务行；400 中文校验错误 |
| GET | `/api/tasks` | 当前用户任务列表（created_at DESC） |
| GET | `/api/tasks/:id` | 单个（跨用户 404） |
| DELETE | `/api/tasks/:id` | 删除（跨用户 404） |
| POST | `/api/tasks/:id/run` | 手动立即触发（next_run_at=now(), status='active'，幂等；running 中返回 409） |
| POST | `/api/chat` | body 加 `background: true` → 直接返回 `{task_id}`，不走 SSE |

全部任务路由：`requireUser` + 无 pool 时 503，错误体 `{error, message}` 中文。

## 状态机

```
active（待运行） ──tick 到期──▶ running（运行中） ──成功──▶ done（已完成）[once]
                                              └─失败──▶ failed（失败）
                   cron 成功 → 回 active（next_run_at 重算）
                   cron 的 nextRun 耗尽 → failed（result 注明 cron 已耗尽）
```

## 验证清单

1. `node --check` 四个文件（已通过）。
2. `node test/scheduler.test.js` → `scheduler tests: 23/23 passed`（已通过）。
3. 接线后手动验证：
   - 面板创建「执行一次」任务 → 30s 内状态变为 done，结果可见。
   - cron `*/1 * * * *` → 每分钟跑一次，next_run_at 递进。
   - composer 勾「后台运行」发送 → 聊天区出现「已创建后台任务（…）」系统提示，任务面板可见。
   - 未登录调 `/api/tasks` → 401；`DELETE` 别人的任务 id → 404。
4. 多实例：`FOR UPDATE SKIP LOCKED` 保证同一任务不会被两个实例重复执行（测试已覆盖语义）。

## 已知限制 / 后续可做（非本次范围）

- 进程内调度：见顶部 ⚠（always-on 是用户决策）。
- tick 间隔默认 30s、单次最多 5 个任务；高频/大量任务场景再调参。
- `result` 截断 20000 字符；超长 agent 输出只保留前部。
- 后台任务**不写 messages 表、不建 session、不做记忆提取**（有意为之，见 `runTaskHeadless` 注释）。
- 时区：cron 按**服务器本地时区**计算；如需用户时区，后续在 tasks 加 `timezone` 列。
