# openmuse

开源的 Muse 式 AI 助手，跑在 [InstaCloud](https://instacloud.com) 上。
MIT 开源，欢迎 fork 和 PR。

v2 的核心是 **muse 式常驻 sandbox**：每个用户拥有一台长期存在的 Linux 云电脑，
agent 可以在上面执行命令、运行代码、读写文件；E2B 原生 pause/resume +
snapshot 检查点保证状态跨会话保留，约 1 秒恢复。

## 架构

```
                    ┌──────────────────────────────┐
                    │        openmuse app          │
用户 ──浏览器──▶    │  Next.js 风格单页 UI + SSE    │──▶ DeepSeek API
                    │                              │    （对话 / tool loop）
                    │  lib/agent.js  tool loop     │
                    │    ├─ sandbox_exec           │
                    │    ├─ sandbox_run_python     │──▶ E2B：每用户一个常驻 sandbox
                    │    ├─ sandbox_read_file     │    /home/user/openmuse-work
                    │    └─ sandbox_write_file    │    原生 pause/resume + snapshot
                    │                              │
                    │  lib/sandbox.js              │──▶ S3 兼容存储：可移植性导出层
                    │   get-or-create / 心跳保活   │    （手动 POST /api/sandbox/export）
                    │   空闲 20min 原生 pause     │
                    └──────────────┬───────────────┘
                                   │ DATABASE_URL
                          ┌────────▼────────┐
                          │    Postgres     │
                          │ sessions /      │
                          │ messages /      │
                          │ user_sandboxes  │
                          └─────────────────┘
```

## 功能

- **流式中文对话**：DeepSeek `deepseek-chat`，SSE 逐 token 输出
- **每用户一台云电脑**：E2B sandbox，`getSandbox()` 按需 get-or-create
- **Agent tool loop**：模型自主决定调 `sandbox_exec / sandbox_run_python / sandbox_read_file / sandbox_write_file`，最多 8 轮；前端把工具调用渲染成可折叠的时间线卡片
- **工作区持久化**：空闲 20 分钟 E2B 原生 `pause()`（保留内存），下次使用约 1 秒自动 resume；每 50 次操作原生 `snapshot` 检查点；也可手动 `POST /api/sandbox/snapshot` / `POST /api/sandbox/pause`
- **会话记忆**：Postgres 存 sessions/messages，侧边栏切换历史
- **长期记忆**：对话后自动提取 fact/preference/project/relationship/decision，
  注入 system prompt；侧边栏可折叠面板查看 + 单条删除（见下文「长期记忆」）
- **状态可见**：侧边栏小圆点显示云电脑「就绪 / 暂停中 / 休眠 / 未配置」

## 环境变量

| 变量 | 必需 | 说明 |
|---|---|---|
| `PORT` | 否 | 监听端口，默认 3000 |
| `DATABASE_URL` | 是 | Postgres 连接串（会话、消息、sandbox 映射都靠它；缺失则聊天/工具不可用） |
| `DEEPSEEK_API_KEY` | 是 | DeepSeek API key |
| `E2B_API_KEY` | 是（云电脑） | E2B API key；缺失则云电脑相关接口返回 503，纯对话不受影响 |
| `BUCKET_NAME` | 是（S3 导出层，可选） | S3 兼容存储的 bucket 名 |
| `AWS_ENDPOINT_URL_S3` | 是（S3 导出层，可选） | S3 endpoint |
| `AWS_REGION` | 否 | 默认 us-east-1 |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | 是（S3 导出层，可选） | S3 凭证 |
| `BETTER_AUTH_SECRET` | 是（登录） | 会话签名密钥，≥ 32 字符：`openssl rand -base64 32` |
| `BETTER_AUTH_URL` | 是（登录） | 对外访问地址，生产环境 `https://openmuse.icu`，本地 `http://localhost:3000` |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | 是（登录） | GitHub OAuth App 凭证 |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | 是（登录） | Google OAuth 客户端凭证 |

所有密钥只从环境变量读取，代码里不写、不打印、不落盘。
InstaCloud 上用 `insta secrets set <NAME>`（值走 stdin）管理。

## 本地运行

```bash
cd app
npm install
DATABASE_URL=postgres://... DEEPSEEK_API_KEY=... E2B_API_KEY=... \
  BUCKET_NAME=... AWS_ENDPOINT_URL_S3=... \
  AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=... \
  npm start
# 打开 http://localhost:3000
```

无 `DATABASE_URL` 时服务能启动，`/api/health` 正常，
但聊天和云电脑接口会返回 503 并给出中文原因。

## 部署到 InstaCloud

```bash
cd /home/hatch/workspace/openmuse   # 项目已用 insta project link 绑定
insta service add postgres memory   # 已有则跳过
insta service add compute app       # 已有则跳过
insta secrets set DEEPSEEK_API_KEY              # 值走 stdin 输入
insta secrets set --service compute/app E2B_API_KEY
insta secrets set --service compute/app BUCKET_NAME
# …其余 AWS_* 同理
insta secrets bind DATABASE_URL postgres/memory --to compute/app
insta deploy ./app --group app --port 3000
```

## 常驻 sandbox 设计要点（v2.1：E2B 原生 persistence）

参考 E2B 官方 persistence 文档（sandbox pause & resume / snapshots），三层设计：

- **原生 pause/resume（主路径）**：创建时 `lifecycle: { onTimeout: 'pause', autoResume: true }`
  （JS SDK 没有顶层 `autoPause` 字段，这是等价写法），超时后自动 pause 而非 kill。
  空闲 20 分钟回收器调用 `pause()`（默认保留完整内存快照）。paused 的 sandbox
  不计费、不占并发、可 indefinite 停留；`Sandbox.connect()` 会自动 resume（约 1s）。
  pause 失败绝不 kill，下分钟重试。执行中的工具（`busy` 标记）不会被 pause。
- **原生 snapshot 检查点**：每 50 次 tool 执行 `createSnapshot()` 一次，只保留最新一个
  （旧的 `Sandbox.deleteSnapshot()` 删掉）。sandbox 被彻底删除时，
  `getSandbox()` 按 DB 里 `snapshot_id` → `Sandbox.create(snapshotId)` 重建。
  也可手动 `POST /api/sandbox/snapshot`。
- **S3 导出层（可移植性）**：`exportToS3` / `importFromS3` 把工作区 tar+base64 存 S3，
  用于跨平台迁移 / 手动备份（`POST /api/sandbox/export`），不在热路径上。
- **get-or-create**：内存 map → `isRunning()` → paused 则 `connect` 自动 resume →
  DB `user_sandboxes` → snapshot 恢复 → 全新创建。v1 单用户，`userId` 固定为 `'default'`。
- **心跳保活**：每次工具执行成功后 `sbx.setTimeout(3_600_000)`。E2B Hobby 计划上限 1 小时。
- **路径安全**：所有文件读写归一化到 `/home/user/openmuse-work` 下，`..` 逃逸直接拒绝。
- **降级**：无 `DATABASE_URL` 时工具调用直接返回「云电脑暂不可用（数据库未配置）」，对话本身照常进行。

## 长期记忆（v1.1）

每用户跨会话的长期记忆，让 agent 越用越了解你。v1 不引入向量依赖：

- **存储**：`memories` 表 `(id, user_id, type, content, importance, created_at, updated_at)`，
  type 取值 `fact / preference / project / relationship / decision`，
  索引 `(user_id, importance DESC, updated_at DESC)`。
- **提取时机**：`/api/chat` 的 SSE `[DONE]` 发送后 fire-and-forget 触发。
  条件：本 session 用户消息 ≥ 2 条且最后一条用户消息长度 > 15（过滤寒暄噪音）。
  用便宜的 `deepseek-chat`（`temperature: 0.3`）做提取，prompt 要求只返回 JSON 数组
  `[{type, content, importance(1-5)}]`；content ≤ 8 字符的条目丢弃。
- **去重**：写入前查该用户已有记忆，新 content 与已有某条互相包含（任一方向）时
  UPDATE 那条（content 取两者较长、importance 取 max、updated_at=now），否则 INSERT。
  提取/写入的异常全部吞掉只打日志，绝不影响主对话。
- **检索**：下次 `/api/chat` 的 system prompt 注入 `<长期记忆>` 块，
  每条 `- [type] content`；无记忆时不注入。v1 按 importance + 时间排序。
- **管理**：前端侧边栏可折叠「🧠 长期记忆」面板，查看 + 单条删除
  （`GET /api/memories`、`DELETE /api/memories/:id`，只能删自己的 `userId`）。
- **v2 计划**：pgvector 语义检索（按当前对话 embedding 召回相关记忆），
  以及记忆合并/过期（低 importance 长时间未命中自动衰减）。

## 登录与多用户（GitHub + Google OAuth）

登录基于 [better-auth](https://better-auth.com)（v1.7.x），数据库直接复用现有 pg Pool，
auth 表为 `user` / `session` / `account` / `verification`（均为单数，
与聊天会话的 `sessions`（复数）表不冲突），由服务启动时的 `initDb()` 幂等创建。

- **启用条件**：`GITHUB_CLIENT_ID`、`GITHUB_CLIENT_SECRET`、
  `GOOGLE_CLIENT_ID`、`GOOGLE_CLIENT_SECRET` 四个环境变量全齐
  （任一 provider 缺失时该登录按钮不显示，但服务不崩）。
  未启用时走**单用户开发模式**：所有接口直接用 `userId='default'` 放行。
- **守卫**：`/api/chat`、`/api/sessions*`、`/api/memories*`、`/api/sandbox/*`
  全部经过 `requireUser` 中间件（`GET /api/auth/get-session` 校验 cookie session）；
  启用登录但无 session 时返回 `401 {error:'unauthorized', message:'请先登录'}`。
- **隔离**：`sessions` 表新增 `user_id` 列（旧数据归 `'default'`），
  会话、消息、长期记忆、sandbox 映射全部按登录用户的 better-auth `user.id` 隔离。
- **前端**：`static/login.html` 登录页（两个 OAuth 按钮）；
  `static/index.html` 启动时先调 `GET /api/auth-config` + `GET /api/auth/get-session`，
  启用登录且无 session 时跳转 `/login.html`，右上角显示用户名/头像 + 登出按钮
  （`POST /api/auth/sign-out`）。`/api/health` 与 `/api/auth/*` 保持公开。
- OAuth token 落库前用 `account.encryptOAuthTokens` 加密（AES-256-GCM）。

### 创建 OAuth 应用

**GitHub**：Settings → Developer settings → OAuth Apps → New OAuth App

| 项 | 填 |
|---|---|
| Application name | openmuse |
| Homepage URL | `https://openmuse.icu` |
| Authorization callback URL | `https://openmuse.icu/api/auth/callback/github` |

创建后拿到 Client ID，Generate new client secret 拿到 Client Secret。

**Google**：[Google Cloud Console](https://console.cloud.google.com) →
API 和服务 → 凭据 → 创建凭据 → OAuth 客户端 ID（应用类型：Web 应用）

| 项 | 填 |
|---|---|
| 名称 | openmuse |
| 已获授权的重定向 URI | `https://openmuse.icu/api/auth/callback/google` |

首次创建需先配置 OAuth 同意屏幕（外部用户类型即可自用）。

### 部署时注入密钥（值走 stdin，不进 shell 历史）

```bash
insta secrets set --service compute/app BETTER_AUTH_SECRET   # openssl rand -base64 32 生成
insta secrets set --service compute/app BETTER_AUTH_URL      # https://openmuse.icu
insta secrets set --service compute/app GITHUB_CLIENT_ID
insta secrets set --service compute/app GITHUB_CLIENT_SECRET
insta secrets set --service compute/app GOOGLE_CLIENT_ID
insta secrets set --service compute/app GOOGLE_CLIENT_SECRET
insta deploy ./app --group app --port 3000
```

## 联网能力（P1）

agent 现在有 `web_search` / `web_read` 两个工具：

- `web_search`：未配 `BRAVE_API_KEY` 时走 DuckDuckGo HTML 解析；配置后改走 Brave Search API（`X-Subscription-Token`）。15s 超时，失败返回中文错误绝不抛错。
- `web_read`：抓取公网网页正文。带 SSRF 防护（拦 10/8、172.16/12、192.168/16、127/8、`::1`、localhost 及 IPv4-mapped IPv6，含重定向后复检）；只收 `text/html`。
- system prompt 约定：涉及时效性信息（新闻、版本发布、CVE、价格）或不确定的外部事实时，先搜索再回答，引用给出来源链接。

可选环境变量：`BRAVE_API_KEY`、`WEB_FETCH_TIMEOUT_MS`（默认 15000，仅调优用）。

## Artifacts 画布（P1）

agent 可调 `create_artifact(title, type, content)` / `update_artifact(id, ...)`，type 限 `html | markdown | svg | code`（500KB 上限）。

- 右侧 420px 画布面板（topbar「画布」开关）；创建成功后自动弹出并渲染。
- 安全红线：html 用 `<iframe sandbox="allow-scripts" srcdoc="…">`，**绝不加 `allow-same-origin`**（opaque origin，iframe JS 触不到父页面）；svg 过滤 `<script>` 与内联事件。
- 按用户 + session 隔离：`GET /api/artifacts?session_id=`、`GET /api/artifacts/:id`、`DELETE /api/artifacts/:id`，全部 `requireUser`。

## 后台任务与定时（P1）

- composer 勾选「后台运行」发送 → `POST /api/chat {background:true}` → 创建 once 任务立即返回 `{task_id}`，不走 SSE。
- 任务抽屉（topbar「任务」）：创建「执行一次」或 cron 定时任务（`0 9 * * *` 这类 5 字段表达式），查看结果、立即运行、删除。
- 调度器每 30s tick：事务内 `SELECT … FOR UPDATE SKIP LOCKED` 抢锁，单 flight 执行；cron 用标准 dom/dow OR 语义。任务以 headless 方式跑一次完整 agent tool loop（**不写 messages、不建 session、不做记忆提取**）。
- ⚠ **进程内调度依赖实例常驻**：compute 休眠/缩容到 0 则定时不触发。要保证可靠请开 always-on——这是用户决策，代码层不擅自改。
- cron 按服务器本地时区计算（容器通常是 UTC：`0 9 * * *` 是 UTC 9 点 = 北京时间 17 点，写定时任务时注意换算）。
- 相关 API（全部 `requireUser`）：`POST /api/tasks`、`GET /api/tasks`、`GET /api/tasks/:id`、`DELETE /api/tasks/:id`、`POST /api/tasks/:id/run`。

## Roadmap

- [ ] 多模型路由与降级（9Router）、逐条 token/成本展示
- [ ] 语音输入（whisper-turbo）
- [ ] noVNC 实时桌面视图（看 agent 操作云电脑）
- [x] 自然语言 cron / 主动推送（P1：后台任务 + cron 调度已上线；自然语言转 cron 表达式待做）
- [x] 多用户账号体系（GitHub + Google OAuth 登录，`userId` 按登录用户隔离）
- [ ] subagents 与 skills 可视化

## 协议

MIT © 2026 cypggs，见 [LICENSE](./LICENSE)。
