# openmuse

开源的 Muse 式 AI 助手，跑在 [InstaCloud](https://instacloud.com) 上。
MIT 开源，欢迎 fork 和 PR。

v2 的核心是 **muse 式常驻 sandbox**：每个用户拥有一台长期存在的 Linux 云电脑，
agent 可以在上面执行命令、运行代码、读写文件，工作区自动快照、跨会话保留。

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
                    │    └─ sandbox_write_file    │
                    │                              │
                    │  lib/sandbox.js              │──▶ S3 兼容存储：工作区快照
                    │   get-or-create / 心跳保活   │    sandbox-snapshots/<user>.tar.gz
                    │   空闲 20min 快照+回收      │
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
- **工作区持久化**：空闲 20 分钟自动 `tar` 快照到 S3，下次使用时恢复；也可手动 `POST /api/sandbox/snapshot`
- **会话记忆**：Postgres 存 sessions/messages，侧边栏切换历史
- **状态可见**：侧边栏小圆点显示云电脑「就绪 / 休眠 / 未配置」

## 环境变量

| 变量 | 必需 | 说明 |
|---|---|---|
| `PORT` | 否 | 监听端口，默认 3000 |
| `DATABASE_URL` | 是 | Postgres 连接串（会话、消息、sandbox 映射都靠它；缺失则聊天/工具不可用） |
| `DEEPSEEK_API_KEY` | 是 | DeepSeek API key |
| `E2B_API_KEY` | 是（云电脑） | E2B API key；缺失则云电脑相关接口返回 503，纯对话不受影响 |
| `BUCKET_NAME` | 是（快照） | S3 兼容存储的 bucket 名 |
| `AWS_ENDPOINT_URL_S3` | 是（快照） | S3 endpoint |
| `AWS_REGION` | 否 | 默认 us-east-1 |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | 是（快照） | S3 凭证 |

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

## 常驻 sandbox 设计要点

- **get-or-create**：内存 map → `isRunning()` 验证 → DB `user_sandboxes` → `Sandbox.connect` → 失败则 `Sandbox.create`。v1 单用户，`userId` 固定为 `'default'`，多租户时换成真实用户 id 即可。
- **心跳保活**：每次工具执行成功后 `sbx.setTimeout(3_600_000)`。E2B Hobby 计划 sandbox 上限 1 小时，这是平台限制，不是 bug。
- **快照恢复**：`tar czf` 工作区 → base64 → S3；恢复时反向操作。快照失败时回收器**不会**杀 sandbox（避免丢数据），下一分钟重试。
- **路径安全**：所有文件读写归一化到 `/home/user/openmuse-work` 下，`..` 逃逸直接拒绝。
- **降级**：无 `DATABASE_URL` 时工具调用直接返回「云电脑暂不可用（数据库未配置）」，对话本身照常进行。

## Roadmap

- [ ] 多模型路由与降级（9Router）、逐条 token/成本展示
- [ ] 语音输入（whisper-turbo）
- [ ] noVNC 实时桌面视图（看 agent 操作云电脑）
- [ ] 自然语言 cron / 主动推送
- [ ] 多用户账号体系（`userId` 接入真实身份）
- [ ] subagents 与 skills 可视化

## 协议

MIT © 2026 cypggs，见 [LICENSE](./LICENSE)。
