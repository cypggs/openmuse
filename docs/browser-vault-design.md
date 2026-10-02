# openmuse 浏览器控制 + 凭证保险库 设计文档

> 状态：设计评审中，未动工。2026-10-02。
> 对标：Muse（Secure VM + 内置浏览器 + 凭证盲用 + Sentinel 审批）。
> 结论前置：不自研浏览器/渲染/vault daemon；Playwright + E2B desktop 模板 + Node crypto，
> openmuse 只做"粘合剂"：编排、审批、策略、驱动。

## 0. 目标与非目标

**目标**：用户在 openmuse 里说"去 example.com 帮我查 X"，agent 能操作真实浏览器完成；
登录过的站点长期保持登录态；密码等凭证用户只交一次、agent 可用但**永远看不到**。

**非目标**：
- 不做通用 RPA / 不承诺过反爬（Cloudflare Turnstile 等按 Muse 做法：停下来问用户，不硬解）
- 不做 passkey（Muse 同样不支持，停下转人工）
- MVP 不防"拿到 DB + env key 的攻击者"（见 §2 威胁模型边界）

## 1. 总体架构

```
┌─ openmuse.icu ─────────────────────────────────────┐
│ 聊天 UI · 审批卡片 · Live View (noVNC iframe)       │
│ 凭证录入页 /vault.html（自有 origin，LLM 不接触）   │
└──────────────────┬─────────────────────────────────┘
                   │ HTTPS / SSE
┌─ openmuse backend (Node, InstaCloud) ──────────────┐
│ Planner：DeepSeek（只见脱敏观察 + 占位符引用）      │
│ 审批网关：approvals 表 + SSE 事件 + decide API      │
│ Sentinel-lite：纯代码策略引擎（域名/敏感分类/审计） │
│ Vault：AES-256-GCM 加解密（master key 在 env）      │
└──────────────────┬─────────────────────────────────┘
                   │ E2B SDK（命令通道 + 端口反代）
┌─ 用户专属 E2B sandbox（desktop 模板，持久） ────────┐
│ browser-driver（Node 小服务，常驻）                 │
│  ├─ Playwright persistent context                  │
│  │    userDataDir=/home/user/.openmuse-browser     │
│  │    headless=false → Xvfb :0（noVNC 可见）        │
│  ├─ 动作执行：navigate / click / fill / press      │
│  ├─ 凭证填入：只在 driver 层执行 page.fill()        │
│  └─ 登录表单检测：上报 {site, fields}，不带值      │
│ XFCE + Chrome + x11vnc + noVNC（:6080）            │
│ pause/resume → 内存+文件+cookie 全保留             │
└───────────────────────────────────────────────────┘
```

**分层原则（抄 Muse / browser-use 的收敛结论）**：
Planner（LLM）与 Driver（代码）严格分离。secret 绝不进入 LLM 上下文——
不在 prompt、不在 tool 参数、不在 tool 结果、不在日志、不在记忆。这是整个方案的安全基石，
与"模型多聪明"无关，是纯粹的分层问题。

## 2. 安全不变量（必须成立，测试要锁）

1. 凭证值永不进 LLM context（prompt / tool 参数 / tool 结果 / 日志 / 记忆）。
2. 填入只发生在 driver 层（`page.fill()`），LLM 只看到"已填入"的状态信号。
3. 敏感动作必须经过审批：用户侧（审批卡片）+ 系统侧（Sentinel-lite 策略引擎）。
4. 每次填入 / 敏感操作写审计日志（who / when / site / kind，不记值）。
5. **威胁模型边界（用户已确认）**：MVP 防"LLM / 日志 / 前端 / 误操作"泄露；
   不防"同时拿到 DB 和 VAULT_MASTER_KEY 的攻击者"——那是 P4 的 per-user 密钥信封加密要解决的。

## 3. P0 — 审批机制（所有敏感操作的前置依赖）

### 3.1 数据模型

```sql
approvals(id, user_id, session_id, kind, title, detail jsonb,
          status pending/approved/denied/expired,
          created_at, decided_at, expires_at);
standing_grants(user_id, scope_kind, scope_value, created_at); -- "始终允许此站点"
approval_audit(id, approval_id, user_id, kind, site, decision, decided_at);
```

`kind` 枚举：`credential_fill` / `browser_navigate_sensitive` / `browser_download` /
`browser_form_submit` / `login_takeover`。`detail` 只放脱敏信息
（如站点域名、掩码用户名 `c***@gmail.com`），永不放值。

### 3.2 流程

1. 任务执行中需要敏感操作 → backend 写 `approvals` 行（status=pending，15 分钟过期）
   → 任务挂起（`awaiting_approval`）。
2. SSE 事件 `openmuse:approval` → 前端渲染审批卡片（标题 + 脱敏详情 +
   [允许一次] [始终允许此站点] [拒绝]）。
3. 用户点击 → `POST /api/approvals/:id/decide` → 状态落库 → 恢复任务执行。
4. 过期未决 → status=expired，任务按拒绝处理并告知用户。

### 3.3 验收

审批卡片发出→点击→任务恢复全链路可用；拒绝/过期路径正确；
"始终允许"写入 standing_grants 且可在设置页撤销（设置页 P3 做，表先建）。

## 4. P1 — browser-driver MVP（E2B desktop）

### 4.1 模板与规格

- `e2b template build` 构建自定义 desktop 模板（基于 `e2b-dev/desktop`：
  Ubuntu 22.04 + XFCE + Chrome + x11vnc + noVNC），`createOpts` 里
  `template: '<template-id>'`。
- **规格待验证**（JS SDK `SandboxOpts` 无 cpu/ram 参数，规格走模板或套餐）：
  目标 2vCPU/4GB；先实测默认规格跑 XFCE+Chrome 是否可用；
  Hobby 1h 上限对长 browser 任务的影响（超时走 pause + autoResume，应可接受）。
  验证结论回填本文档。

### 4.2 driver 形态

- sandbox 内常驻 Node 小服务 `driver.js`（随 sandbox 启动拉起，写进模板的 start 命令）。
- Playwright `launchPersistentContext(userDataDir='/home/user/.openmuse-browser',
  headless=false, args=['--display=:0' …])` —— 接 Xvfb，noVNC 里看得到真实操作。
- backend↔driver 通信：E2B 端口反代（`sbx.getHost(port)`）暴露 driver 的 HTTP API；
  或复用 `sbx.commands.run`。P1 用 HTTP 反代（简单、可观测）。
- driver 重启/崩溃：supervisor 踢一下重拉（P1 简单重试；P4 再做健康检查）。

### 4.3 Planner 观察与动作空间

- 观察以 **accessibility tree 快照（文本）** 为主（DeepSeek 无 vision，
  文本 a11y tree 是 browser-use 的标准做法）+ 按需 screenshot（给用户看 / 调试）。
- 动作（tool）：`browser_navigate` / `browser_snapshot` / `browser_click(ref)` /
  `browser_fill(ref, text)`（**非凭证**）/ `browser_press(key)` / `browser_screenshot`。
  动作空间保持小（对标 Muse 的 action_boundary）。
- **凭证填入专用 tool** `browser_fill_credentials(site_ref)`：LLM 只传占位符引用
  （如 vault 行 id），backend 查 vault 解密 → 经 E2B 通道发给 driver → driver `page.fill()`。
  LLM 的 tool 结果只有 `{filled: true, fields: ['username','password']}`。
- 填入步骤的 screenshot **跳过**（browser-use `use_vision=False` 的思想），
  防止密码明文进截图再进上下文。

### 4.4 登录表单检测

driver 上报 `login_form_detected {site, fields: ['username','password']}`，
**不带任何值**。backend 收到后走 §6 的 vault/审批流。

### 4.5 验收

- "打开 example.com 并截图"端到端可用。
- cookie 登录态跨 pause/resume 保留（实测：登录 → 等 20min pause → 新任务打开同一站仍是登录态）。

## 5. P2 — Live View（用户观看 + 接管）

- `stream.get_url(auth_key)`（desktop SDK）或 noVNC 直连 sandbox 6080（经 `getHost` 反代），
  嵌进 openmuse 前端一个"浏览器"面板（iframe）。
- noVNC 原生可交互 → **用户随时接管**（对标 Muse "watch & takeover"）。
- **主路径登录 UX**：agent 遇到登录墙 → 审批卡片给选项"亲自登录（打开 Live View）"→
  用户在 noVNC 里自己输密码 → cookie 进 persistent profile → 以后长期有效。
  这是体验最好、最符合"不泄露"的一条路（密码从没离开过用户手指）。
- auth key 管理：MVP 直连 E2B URL（自带密码）；P4 考虑经 backend 反代以便审计。

### 验收

Live View 可看、操作同步可见；用户接管后 agent 能检测到并暂停（noVNC 有输入即视为接管中，
driver 暂停发动作——细节 P2 实现时定）。

## 6. P3 — 凭证保险库（Vault）

### 6.1 存储

```sql
vault_credentials(user_id, site, username_enc, password_enc, iv, tag,
                  created_at, updated_at);
```

- AES-256-GCM；key = HKDF-SHA256(master=`VAULT_MASTER_KEY`(env), info=`user_id`)；
  每行随机 IV。MVP 不做信封加密（P4）。
- 用户可查可删：`GET /api/vault/sites` 只返回站点列表 + 更新时间（**不返回值**）；
  `DELETE /api/vault/credentials/:site`。

### 6.2 录入

- `/vault.html`（openmuse 自有 origin 的独立页面）：site + username + password
  → `POST /api/vault/credentials` → 服务端加密入库。LLM 全程不接触。
- 入口：审批卡片上的"去填写凭证"按钮；设置页的"已保存登录"管理（P3 做设置页）。

### 6.3 填入流（兜底路径）

1. driver 上报 `login_form_detected(site)`。
2. backend 查 vault：有 → 审批卡片（"允许填入 example.com 的已保存登录？
   账号 c***@gmail.com [允许一次] [始终允许] [拒绝]"）。
3. 批准 → 后端解密 → 发给 driver → `page.fill()` → 写 `approval_audit`。
4. 无 vault 条目 → 审批卡片给两个选项：[去填写凭证] [亲自登录（Live View）]。

### 6.4 一次性验证码

- 用户在聊天里粘贴 → backend 内存持有，5 分钟 TTL，**单次使用**，不写库、不记日志值。
  （对标 Muse 的 authd opaque reference 的简化版。）
- driver 填入后立即从内存清除。

### 6.5 验收（红线测试）

- 保存凭证 → 审批 → 填入 → 登录成功，全链路可用。
- **抽查 LLM context（含 tool 结果、日志、记忆写入）无凭证值残留**——把这条写成回归测试。

## 7. P4 — 加固：Sentinel-lite 策略引擎 + 密钥体系

- **策略引擎**（backend 纯代码中间件，非 LLM）：
  - 每个 browser 任务声明意图域名；导航出 allowlist → 审批（Muse 的 L4+L7 出口检查的轻量版）。
  - 敏感分类（银行 / 支付 / 政务 / 邮箱）：**强制每次审批**，不可 "always allow"；
    参考 Muse 的 sensitive_sites 策略。
  - 复用现有 SSRF 防护（`web_read` 那套：字面 IP / DNS 结果 / 169.254/16 / v6 特殊段 /
    重定向二次检查）到浏览器网络层。
  - 完整审计：`approval_audit` + browser 动作日志（导航/填入/下载），用户可在设置页查看。
- **密钥体系**：per-user DEK 信封加密（KEK 在 env，未来可接 KMS）；轮换流程文档化。
- **截图脱敏**：密码字段聚焦/填入期间的 screenshot 打码或跳过（P1 做了跳过，P4 做字段级打码）。

## 8. 成本与规格（2026-10-02 P1 spike 实测结论）

> 以下为生产容器内实测（`insta compute exec` + E2B SDK），非文档推测。

### 实测数据

| 项目 | 结果 |
|---|---|
| 默认 sandbox 规格 | **2 CPU / 478 MB**（低于文档称的 1G；Debian 12） |
| 默认规格 + Chrome 154 | ❌ 跑不起来：headless 截图挂起 60s 被杀；`--single-process` exit=0 但无输出 |
| 模板指定规格 | ✅ `Template.build(tpl, name, {cpuCount: 2, memoryMB: 4096})` 成功 |
| 新模板起 sandbox | ✅ `nproc`=2，`free`=**3931 MB**（4096 扣除系统保留），规格如实生效 |
| 模板构建方式 | ✅ SDK `Template.build` / `buildInBackground` 可用；CLI 亦支持 `--cpu-count/--memory-mb` |

### 桌面模板验证（2026-10-02，`openmuse-desktop` 构建成功）

模板内容：Ubuntu 22.04 + Xvfb + openbox + x11vnc + noVNC/websockify + Chrome 154 + Node 20 + Playwright。

| 验证项 | 结果 |
|---|---|
| 构建 | ✅ `Template.build` 一次成功（约 20 分钟；需 `.setUser('root')` 否则 apt-key 报权限错误） |
| 自启动 | ✅ sandbox 启动后 Xvfb :99、openbox、x11vnc :5900、websockify :6080 自动运行 |
| headless 截图 | ✅ `google-chrome --headless --screenshot` 正常出图（20874 字节） |
| 规格 | ✅ 2C / 3931MB |

注意：构建期间**不要 `insta deploy`**（容器重启会杀掉构建进程）；改用 `buildInBackground` + 保存 `{templateId, buildId}` 可断点续查。

### 结论

1. **浏览器必须走自定义模板 + 4G 内存**：默认 478MB 连 headless Chrome 截图都完不成，
   不是"慢"而是"不可用"。`--memory-mb 4096` 为必选，非可选。
2. **Q1/Q2/Q3 全部 answered**：Q1（默认规格不行）/ Q2（模板可定规格）/ Q3（构建一次成功）。
3. 本沙盒直连 E2B 有代理兼容问题（SDK/CLI 的 undici 不走代理，TLS 报 wrong version）；
   spike 改从生产容器（`insta compute exec`）执行，E2B SDK 在生产侧工作正常。
   日常开发不受影响（openmuse 后端本就跑在生产侧）。

### 待办（P1 实施前）

- [x] 构建完整 desktop 模板（`openmuse-desktop`，2C/4G，Chrome 154 + Xvfb + noVNC）
- [x] 在 4G 模板上实测 Chrome headless 截图（✅）+ 桌面自启动（✅）
- [ ] 去 e2b.dev/pricing 核对 2C/4G 的计费（spike 未覆盖价格）。
- [ ] 测试模板 `openmuse-spike-minimal` 为 spike 产物，可删除。
- [ ] P1 browser-driver：Playwright driver + 审批集成（见 §4）。

## 9. 实施顺序与依赖

```
P0 审批机制 ──┬── P1 driver MVP ── P2 Live View ── P3 Vault ── P4 加固
              │
              └── P1 的 driver 检测能力是 P3 填入流的前置；
                  P2 的 Live View 是 P3 主路径登录 UX 的前置
```

P0 可独立先行；P1 需要 E2B 模板实测（§8）；P2/P3 都依赖 P1。

## 10. 风险

- E2B desktop 模板构建/ChromeDriver 版本/中文输入法等实测坑（P1 spike 先行，2 天封顶）。
- DeepSeek 无 vision：复杂页面（canvas 验证码、拖拽滑块）只能转人工——按 Muse 做法，
  CAPTCHA 停下问用户，不硬解。
- noVNC 直连 URL 的 auth key 若泄露则他人可看用户浏览器：MVP 靠 E2B 自带密码；
  长期走 backend 反代 + 短期 token（P4）。
