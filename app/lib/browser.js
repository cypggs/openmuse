// openmuse P1 — browser backend（驱动 sandbox 内的 driver.js）。
//
// 架构：
// - driver 跑在用户 sandbox 内（127.0.0.1:18789），backend 经 E2B 通道调用。
// - 敏感操作（登录表单填入等）走审批网关（lib/approvals.js）。
// - LLM 只见脱敏观察（a11y tree 文本 + {filled:true}），不见凭证值。
'use strict';

const sandboxMgr = require('./sandbox');
const approvals = require('./approvals');

const DRIVER_PORT = 18789;
// driver 在 sandbox 内的路径
const DRIVER_REMOTE_PATH = '/home/user/driver.js';

// ---------- pool (injected by server.js, 同 sandbox.js 模式) ----------
let pool = null;
function setPool(p) {
  pool = p;
}

// 敏感站点：导航到这些域名需要审批（P1 初始列表，P4 由 Sentinel-lite 接管）
const SENSITIVE_DOMAINS = [
  'github.com', 'google.com', 'accounts.google.com',
  'mail.google.com', 'outlook.com', 'login.microsoftonline.com',
];

/**
 * 确保 driver 在运行。返回 driver 的 base URL（经 E2B 通道）。
 * driver 不在时上传并启动。
 */
async function ensureDriver(userId) {
  const sbx = await sandboxMgr.getSandbox(userId);

  // 检查 driver 是否在跑
  try {
    const health = await driverFetch(sbx, '/health', { method: 'GET' });
    if (health.ok) return sbx;
  } catch (_) {
    // 不在跑，继续启动流程
  }

  console.log(`[browser] starting driver for user ${userId}`);
  // 上传 driver.js（从 backend 的 driver/ 目录）
  const fs = require('fs');
  const path = require('path');
  const driverSrc = fs.readFileSync(path.join(__dirname, '..', 'driver', 'driver.js'), 'utf8');
  await sbx.files.write(DRIVER_REMOTE_PATH, driverSrc);

  // 启动（后台，输出到日志文件）
  // NODE_PATH 指向全局 playwright
  await sbx.commands.run(
    `NODE_PATH=$(npm root -g) nohup node ${DRIVER_REMOTE_PATH} > /tmp/driver.log 2>&1 < /dev/null & echo started`,
    { timeoutMs: 15000 }
  );

  // 等待就绪（最多 30s）
  for (let i = 0; i < 15; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    try {
      const h = await driverFetch(sbx, '/health', { method: 'GET' });
      if (h.ok) {
        console.log(`[browser] driver ready for user ${userId}`);
        return sbx;
      }
    } catch (_) {}
  }
  throw new Error('driver 启动超时');
}

/**
 * 经 E2B 通道调用 driver HTTP API。
 * 用 sbx.commands.run 做 curl（简单可靠，不依赖端口反代）。
 */
async function driverFetch(sbx, path, { method = 'GET', body } = {}) {
  const args = [`-s`, `-X`, method, `http://127.0.0.1:${DRIVER_PORT}${path}`];
  if (body !== undefined) {
    // body 经 base64 传递，避免引号转义问题
    const b64 = Buffer.from(JSON.stringify(body)).toString('base64');
    args.push('-H', 'Content-Type: application/json', '--data-binary', `@<(echo ${b64} | base64 -d)`);
  }
  // screenshot 返回二进制，单独处理
  const isScreenshot = path === '/screenshot' && method === 'GET';
  const cmd = isScreenshot
    ? `curl -s http://127.0.0.1:${DRIVER_PORT}/screenshot | base64 -w 0`
    : `curl ${args.map((a) => `'${a}'`).join(' ')}`;

  const result = await sbx.commands.run(cmd, { timeoutMs: 45000 });
  if (result.exitCode !== 0) {
    throw new Error(`driver 调用失败: ${result.stderr.slice(0, 100)}`);
  }
  if (isScreenshot) {
    return Buffer.from(result.stdout.trim(), 'base64');
  }
  try {
    return JSON.parse(result.stdout);
  } catch (_) {
    throw new Error(`driver 返回非 JSON: ${result.stdout.slice(0, 100)}`);
  }
}

// ---------- 高层 API（给 agent tools 用） ----------

async function navigate(userId, url, opts = {}) {
  // 敏感站点检查
  const domain = new URL(url).hostname.toLowerCase();
  const isSensitive = SENSITIVE_DOMAINS.some((d) => domain === d || domain.endsWith('.' + d));
  if (isSensitive && !opts.skipApproval) {
    if (!pool) throw new Error('敏感站点需要审批，但数据库未就绪');
    // 检查 standing grant
    const granted = await approvals.checkGrant(pool, {
      userId, scopeKind: 'sensitive_nav', scopeValue: domain,
    });
    if (!granted) {
      const approval = await approvals.createApproval(pool, {
        userId,
        sessionId: opts.sessionId,
        kind: 'sensitive_nav',
        title: `打开敏感站点`,
        detail: { site: domain, url: url.slice(0, 120), action: '导航' },
      });
      const decision = await approvals.waitForDecision(approval.id);
      if (decision !== 'allow_once' && decision !== 'allow_always') {
        throw new Error(`用户${decision === 'deny' ? '拒绝' : '未决定'}了敏感站点访问`);
      }
    }
  }
  const sbx = await ensureDriver(userId);
  return driverFetch(sbx, '/navigate', { method: 'POST', body: { url } });
}

async function snapshot(userId) {
  const sbx = await ensureDriver(userId);
  const result = await driverFetch(sbx, '/snapshot', { method: 'GET' });
  // 登录表单检测 → 触发审批/凭证流（P1 只上报，P3 才自动填）
  // 注意：不上报任何值，只上报元数据
  return result;
}

async function click(userId, ref) {
  const sbx = await ensureDriver(userId);
  return driverFetch(sbx, '/click', { method: 'POST', body: { ref } });
}

async function fill(userId, ref, text) {
  const sbx = await ensureDriver(userId);
  return driverFetch(sbx, '/fill', { method: 'POST', body: { ref, text } });
}

async function press(userId, key) {
  const sbx = await ensureDriver(userId);
  return driverFetch(sbx, '/press', { method: 'POST', body: { key } });
}

async function screenshot(userId) {
  const sbx = await ensureDriver(userId);
  return driverFetch(sbx, '/screenshot', { method: 'GET' }); // 返回 Buffer
}

/**
 * P2: 获取 noVNC Live View URL。
 * 经 E2B getHost(6080) 反代，直接可访问（MVP 无密码，P4 加 backend 反代审计）。
 */
async function getLiveUrl(userId) {
  const sbx = await ensureDriver(userId); // 确保 desktop 在跑
  // 确保 websockify 正确 serve noVNC 文件（模板里的启动命令缺 --web 参数，405 的根因）
  await ensureWebsockify(sbx);
  const host = sbx.getHost(6080);
  // noVNC 的 index.html 已 symlink 到 vnc.html
  return `https://${host}/`;
}

/**
 * 确保 websockify 在 6080 上正确运行（带 --web serve 静态文件）。
 * 模板的 start-desktop.sh 里 websockify 缺 --web 参数，会导致 405。
 */
async function ensureWebsockify(sbx) {
  // 检查 6080 是否返回 200（注意：curl 失败时 -w 输出 000，不要再 echo，避免 "000000"）
  const check = await sbx.commands.run(
    'curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:6080/ 2>/dev/null; true'
  );
  const code = check.stdout.trim();
  if (code === '200') return; // 正常

  console.log(`[browser] websockify on 6080 returned ${code}, restarting with --web...`);
  // 分两步：先杀旧的（单条命令，避免 pkill 匹配到自身），再启动新的
  // 注意：用 /opt/noVNC/utils/websockify/run，不是 python3 -m websockify（模块未安装）
  await sbx.commands.run('pkill -f "[w]ebsockify" 2>/dev/null; sleep 1; true', { timeoutMs: 10000 });
  await sbx.commands.run(
    'nohup /opt/noVNC/utils/websockify/run --web /opt/noVNC 6080 localhost:5900 > /tmp/websockify.log 2>&1 < /dev/null & ' +
    'sleep 2; curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:6080/ 2>/dev/null; true',
    { timeoutMs: 15000 }
  );
}

/**
 * H264 推流 URL（对标 Memoh 的 GStreamer → H264 → 浏览器）。
 * 确保 h264-stream.js 在 sandbox 内运行，返回 wss:// 地址。
 * 前端用 WebCodecs 解码 H264 → canvas（传输层预留 WebRTC 替换位）。
 */
const fs = require('fs');
const path = require('path');
const H264_PORT = 8889;
const H264_REMOTE_PATH = '/home/user/h264-stream.js';

async function ensureH264Stream(sbx) {
  // 检查是否在运行
  const check = await sbx.commands.run(
    'curl -s --max-time 3 http://127.0.0.1:8889/health 2>/dev/null || echo "DOWN"',
    { timeoutMs: 8000 }
  );
  if (check.stdout.includes('"ok":true')) return;

  console.log('[browser] h264-stream not running, starting...');

  // 确保 GStreamer 已安装（新模板会预装，老 sandbox 运行时补装）
  const gstCheck = await sbx.commands.run('which gst-launch-1.0 2>/dev/null || echo "MISSING"', { timeoutMs: 8000 });
  if (gstCheck.stdout.includes('MISSING')) {
    console.log('[browser] installing gstreamer...');
    await sbx.commands.run(
      'DEBIAN_FRONTEND=noninteractive apt-get update -qq && ' +
      'DEBIAN_FRONTEND=noninteractive apt-get install -y -qq ' +
      'gstreamer1.0-tools gstreamer1.0-plugins-base gstreamer1.0-plugins-good ' +
      'gstreamer1.0-plugins-bad gstreamer1.0-plugins-ugly 2>&1 | tail -2',
      { timeoutMs: 300000 }
    );
    console.log('[browser] gstreamer installed');
  }

  // 上传
  const src = fs.readFileSync(path.join(__dirname, '../driver/h264-stream.js'), 'utf8');
  await sbx.files.write(H264_REMOTE_PATH, src);
  // 启动（按端口杀旧进程，避免 pkill 自杀）
  await sbx.commands.run('fuser -k 8889/tcp 2>/dev/null; sleep 1; true', { timeoutMs: 10000 });
  await sbx.commands.run(
    'nohup node /home/user/h264-stream.js > /tmp/h264.log 2>&1 < /dev/null & sleep 3; true',
    { timeoutMs: 15000 }
  );
  // 确认
  const verify = await sbx.commands.run(
    'curl -s --max-time 3 http://127.0.0.1:8889/health 2>/dev/null || echo "DOWN"',
    { timeoutMs: 8000 }
  );
  if (!verify.stdout.includes('"ok":true')) {
    throw new Error('h264-stream 启动失败');
  }
  console.log('[browser] h264-stream started');
}

async function getStreamUrl(userId) {
  const sbx = await ensureDriver(userId);
  await ensureH264Stream(sbx);
  const host = sbx.getHost(H264_PORT);
  return `wss://${host}/`;
}

/**
 * 终端 WebSocket URL。
 * 确保 terminal.js 在 sandbox 内运行，返回 wss:// 地址。
 * 前端用 xterm.js 连接。
 */
const TERM_PORT = 8890;
const TERM_REMOTE_PATH = '/home/user/terminal.js';

async function ensureTerminal(sbx) {
  const check = await sbx.commands.run(
    'curl -s --max-time 3 http://127.0.0.1:8890/health 2>/dev/null || echo "DOWN"',
    { timeoutMs: 8000 }
  );
  if (check.stdout.includes('"ok":true')) return;

  console.log('[browser] terminal not running, starting...');
  const src = fs.readFileSync(path.join(__dirname, '../driver/terminal.js'), 'utf8');
  await sbx.files.write(TERM_REMOTE_PATH, src);
  await sbx.commands.run('fuser -k 8890/tcp 2>/dev/null; sleep 1; true', { timeoutMs: 10000 });
  await sbx.commands.run(
    'nohup node /home/user/terminal.js > /tmp/terminal.log 2>&1 < /dev/null & sleep 2; true',
    { timeoutMs: 15000 }
  );
  const verify = await sbx.commands.run(
    'curl -s --max-time 3 http://127.0.0.1:8890/health 2>/dev/null || echo "DOWN"',
    { timeoutMs: 8000 }
  );
  if (!verify.stdout.includes('"ok":true')) {
    throw new Error('terminal 启动失败');
  }
  console.log('[browser] terminal started');
}

async function getTerminalUrl(userId) {
  const sbx = await ensureDriver(userId);
  await ensureTerminal(sbx);
  const host = sbx.getHost(TERM_PORT);
  return `wss://${host}/`;
}

module.exports = {
  setPool,
  ensureDriver,
  navigate,
  snapshot,
  click,
  fill,
  press,
  screenshot,
  getLiveUrl,
  getStreamUrl,
  getTerminalUrl,
  DRIVER_PORT,
  SENSITIVE_DOMAINS,
};
