# Artifacts 画布 — 集成说明（给 Coordinator）

Worker B（Artifacts 画布）已完成以下 5 个新增文件，**未修改任何现有文件**。集成方式：按下面的三块代码分别粘贴到 `server.js` / `lib/agent.js` / `static/index.html` 的指定位置。

## 新增文件清单

| 文件 | 说明 |
|---|---|
| `lib/artifacts.js` | DB 操作（setPool / create / get / list / update / delete）、`ARTIFACTS_DDL`、`ARTIFACT_TOOLS`（OpenAI function 格式）、`executeCreateArtifact` / `executeUpdateArtifact`、中文 `ARTIFACT_PROMPT` |
| `lib/artifactRoutes.js` | `registerArtifactRoutes(app, {pool, requireUser})`：`GET /api/artifacts?session_id=`、`GET /api/artifacts/:id`、`DELETE /api/artifacts/:id`，错误格式 `{error, message}` 中文 |
| `static/artifact-panel.js` | 自包含前端面板（classic script）：向 `.topbar` 注「画布」开关，向 `.app` 注入右侧 `.canvas-panel`（420px、默认隐藏）；监听 `CustomEvent('openmuse:artifact')` 自动拉取并渲染。iframe 渲染红线：`sandbox="allow-scripts"`，**绝不加 `allow-same-origin`**，srcdoc 做属性转义；svg 过滤 `<script>` 与内联事件 |
| `test/artifacts.test.js` | 纯 node + assert mock 测试，`node test/artifacts.test.js` 运行 |
| 本文档 | 集成接线 |

## ① server.js 接线

（1）在文件顶部 require 区，`const authLib = require('./lib/auth');` 附近加：

```js
const artifacts = require('./lib/artifacts');
const { registerArtifactRoutes } = require('./lib/artifactRoutes');
```

（2）在 `sandboxMgr.setPool(pool); memory.setPool(pool);` 附近加：

```js
artifacts.setPool(pool);
```

（3）在 `initDb()` 里（例如 memories 建表之后、better-auth 表之前均可）加：

```js
await pool.query(artifacts.ARTIFACTS_DDL);
```

（4）在 memories 路由（`/api/memories/:id` 的 DELETE）之后、`// ---------- static ----------` 之前加：

```js
// ---------- artifacts（画布 v1）----------
registerArtifactRoutes(app, { pool, requireUser });
```

注意：`registerArtifactRoutes` 内部自带 requireDb 语义（无 pool 时 503），且内部会再调 `artifacts.setPool(pool)`，第（2）步可视为双保险。

## ② lib/agent.js 接线

（1）文件顶部加：

```js
const artifacts = require('./artifacts');
```

（2）`TOOLS` 数组末尾追加：

```js
...artifacts.ARTIFACT_TOOLS,
```

（3）`SYSTEM_PROMPT` 末尾追加：

```js
const SYSTEM_PROMPT =
  '……现有内容……' +
  artifacts.ARTIFACT_PROMPT;
```

（注意 SYSTEM_PROMPT 目前是一个拼接字面量，在最后 `+ artifacts.ARTIFACT_PROMPT;` 即可。）

（4）`toolLabel` 的 switch 里加中文标签：

```js
case 'create_artifact':
  return '创建画布内容：' + (args.title || '');
case 'update_artifact':
  return '更新画布内容';
```

（5）`executeTool(name, args, userId)` 改为接受 ctx 透传 sessionId（签名建议改为 `executeTool(name, args, ctx)`，ctx={userId, sessionId}），switch 里加：

```js
case 'create_artifact':
  return artifacts.executeCreateArtifact(args, ctx);
case 'update_artifact':
  return artifacts.executeUpdateArtifact(args, ctx);
```

如果不想改 executeTool 签名，也可以在 runAgent 里单独处理：create/update 的 ctx 需要 `{userId, sessionId}`，因为 artifact 按 session 归档（listArtifacts 支持 `?session_id=` 过滤）。

（6）SSE 事件：在 `runAgent` 的 tool loop 里，`emit({ t: 'tool_end', ... })` 之后加：

```js
const res = await executeTool(tc.function.name, args, ctx);
emit({ t: 'tool_end', id: tc.id, ok: res.ok, output: res.output });
if (res.artifact) {
  emit({ t: 'artifact', id: res.artifact.id, title: res.artifact.title, type: res.artifact.type });
}
```

`executeCreateArtifact` 成功时返回 `artifact: {id, title, type}`，失败时无此字段，因此只需判 `res.artifact` 存在。

## ③ static/index.html 接线

（1）在唯一的 `<script>` 之前（或之后，顺序无要求）加：

```html
<script src="/artifact-panel.js"></script>
```

（2）在 `doSend()` 的 SSE 分发里（`else if(o.t==='tool_end'){toolEnd(body,o);}` 那一行之后）加：

```js
else if(o.t==='artifact'){window.dispatchEvent(new CustomEvent('openmuse:artifact',{detail:o}));}
```

artifact-panel.js 监听该事件，自动 `GET /api/artifacts/:id` 拉取全文并在右侧画布渲染。

## 安全红线（已在实现中落实，合并时不要改动）

- html 类型：`<iframe sandbox="allow-scripts" srcdoc="...">`，**绝不加 `allow-same-origin`**（opaque origin，iframe 内的 JS 无法访问父页面 DOM/cookie）。
- srcdoc 内容经过属性转义；标题一律 HTML 转义；code 类型用 `textContent` 赋值。
- svg 类型：正则去掉 `<script>…</script>` 及所有内联事件属性（`on*=…`）后再 innerHTML。
- 所有 SQL 都有 `user_id = $n` 条件，路由层走现有 `requireUser`，跨用户无法读写他人 artifact。

## 验证

```bash
cd /home/hatch/workspace/openmuse/app
node --check lib/artifacts.js
node --check lib/artifactRoutes.js
node --check static/artifact-panel.js
node --check test/artifacts.test.js
node test/artifacts.test.js   # 期望输出 artifacts tests: N/N passed
```
