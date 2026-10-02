// openmuse P1 — browser driver（运行在 E2B desktop sandbox 内）。
// Playwright persistent context + HTTP API，供 backend 调用。
// 启动：NODE_PATH=$(npm root -g) node driver.js
// 安全：只监听 127.0.0.1，由 E2B 端口反代暴露；不处理凭证（P3 才加）。
'use strict';

const http = require('http');
const { chromium } = require('playwright');

const PORT = parseInt(process.env.DRIVER_PORT || '18789', 10);
const USER_DATA_DIR = process.env.BROWSER_PROFILE || '/home/user/.openmuse-browser';
const DISPLAY = process.env.DISPLAY || ':99';

let browser = null;
let context = null;
let page = null;

async function ensureBrowser() {
  if (page && !page.isClosed()) return page;
  // 优先连模板开机启动的 Chrome（CDP 9222，对标 agentbox）
  try {
    console.log('[driver] trying CDP connect to :9222...');
    const cdpBrowser = await chromium.connectOverCDP('http://127.0.0.1:9222', { timeout: 5000 });
    const contexts = cdpBrowser.contexts();
    if (contexts[0]) {
      context = contexts[0];
      page = context.pages()[0] || await context.newPage();
      console.log('[driver] Chrome connected via CDP');
      return page;
    }
  } catch (e) {
    console.log('[driver] CDP connect failed, falling back to launch:', e.message.slice(0, 80));
  }
  // Fallback：老模板没有开机 Chrome，自己 launch（persistent profile）
  console.log('[driver] launching Chrome (display ' + DISPLAY + ')...');
  context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: false,
    executablePath: '/usr/bin/google-chrome',
    args: [
      '--display=' + DISPLAY,
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
      '--window-size=1280,800',
    ],
    viewport: { width: 1280, height: 800 },
  });
  page = context.pages()[0] || await context.newPage();
  console.log('[driver] Chrome launched');
  return page;
}

// snapshot：用 DOM 解析提取可交互元素（不依赖 page.accessibility API）
// 为 snapshot 建立 ref → element 映射（click/fill 用）
let refMap = new Map();
let refCounter = 0;

async function buildRefMap(page) {
  refMap = new Map();
  refCounter = 0;
  // 在页面内执行 JS，提取可交互元素（返回 role/text/type）
  const elements = await page.evaluate(() => {
    const out = [];
    const sel = 'a, button, input, select, textarea, [role="button"], [role="link"], [role="textbox"], [role="checkbox"], [role="radio"], [role="combobox"], [role="tab"]';
    const nodes = document.querySelectorAll(sel);
    for (let i = 0; i < nodes.length && out.length < 100; i++) {
      const el = nodes[i];
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) continue;
      const text = (el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('name') || '').trim().slice(0, 60);
      const tag = el.tagName.toLowerCase();
      let role = tag;
      if (tag === 'a') role = 'link';
      else if (tag === 'button' || el.getAttribute('role') === 'button') role = 'button';
      else if (tag === 'input') {
        const t = (el.getAttribute('type') || 'text').toLowerCase();
        role = t === 'checkbox' ? 'checkbox' : t === 'radio' ? 'radio' : 'textbox';
      }
      else if (tag === 'select') role = 'combobox';
      else if (tag === 'textarea') role = 'textbox';
      out.push({ idx: i, role, text, inputType: el.getAttribute('type') || '' });
    }
    return out;
  });
  for (const el of elements) {
    refCounter++;
    refMap.set('e' + refCounter, el.idx);
  }
  return elements;
}

// 格式化为文本快照（给 LLM 看）
function formatSnapshot(elements) {
  return elements.map((el, i) => {
    let line = `[e${i + 1}] ${el.role}`;
    if (el.text) line += ` "${el.text}"`;
    if (el.inputType && el.inputType !== 'text') line += ` (type=${el.inputType})`;
    return line;
  }).join('\n');
}

function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 1e6) reject(new Error('body too large')); });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); }
      catch (e) { reject(new Error('invalid json')); }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    // ---- GET /health ----
    if (req.method === 'GET' && url.pathname === '/health') {
      return sendJson(res, 200, { ok: true, hasPage: !!(page && !page.isClosed()) });
    }

    // ---- POST /navigate {url} ----
    if (req.method === 'POST' && url.pathname === '/navigate') {
      const { url: target } = await readBody(req);
      if (!target || !/^https?:\/\//.test(target)) {
        return sendJson(res, 400, { error: 'invalid_url' });
      }
      const p = await ensureBrowser();
      await p.goto(target, { waitUntil: 'domcontentloaded', timeout: 30000 });
      return sendJson(res, 200, { ok: true, url: p.url(), title: await p.title().catch(() => '') });
    }

    // ---- GET /snapshot ----
    if (req.method === 'GET' && url.pathname === '/snapshot') {
      const p = await ensureBrowser();
      const elements = await buildRefMap(p);
      const snapshot = formatSnapshot(elements);
      // 检测登录表单（不带值）
      const hasPassword = elements.some((e) => e.role === 'textbox' && /pass/i.test(e.inputType));
      const hasUsername = elements.some((e) => e.role === 'textbox' && /user|email|account|login/i.test(e.text));
      return sendJson(res, 200, {
        url: p.url(),
        title: await p.title().catch(() => ''),
        snapshot,
        truncated: elements.length >= 100,
        login_form_detected: hasPassword && hasUsername ? { fields: ['username', 'password'] } : null,
      });
    }

    // ---- POST /click {ref} ----
    if (req.method === 'POST' && url.pathname === '/click') {
      const { ref } = await readBody(req);
      const idx = refMap.get(ref);
      if (idx === undefined) return sendJson(res, 400, { error: 'unknown_ref', message: 'ref 不存在，先调 /snapshot' });
      const p = await ensureBrowser();
      // 用 DOM idx 定位（与 buildRefMap 的 querySelectorAll 顺序一致）
      await p.evaluate((i) => {
        const sel = 'a, button, input, select, textarea, [role="button"], [role="link"], [role="textbox"], [role="checkbox"], [role="radio"], [role="combobox"], [role="tab"]';
        const el = document.querySelectorAll(sel)[i];
        if (!el) throw new Error('element not found at idx ' + i);
        el.click();
      }, idx);
      await p.waitForTimeout(800);
      return sendJson(res, 200, { ok: true });
    }

    // ---- POST /fill {ref, text}（非凭证；凭证走 P3 专用通道）----
    if (req.method === 'POST' && url.pathname === '/fill') {
      const { ref, text } = await readBody(req);
      if (typeof text !== 'string' || text.length > 500) {
        return sendJson(res, 400, { error: 'invalid_text' });
      }
      const idx = refMap.get(ref);
      if (idx === undefined) return sendJson(res, 400, { error: 'unknown_ref' });
      const p = await ensureBrowser();
      await p.evaluate(([i, v]) => {
        const sel = 'a, button, input, select, textarea, [role="button"], [role="link"], [role="textbox"], [role="checkbox"], [role="radio"], [role="combobox"], [role="tab"]';
        const el = document.querySelectorAll(sel)[i];
        if (!el) throw new Error('element not found at idx ' + i);
        el.focus();
        // 用原生 setter 触发 React/Vue 的 onChange
        const setter = Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value')?.set
          || Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
        if (setter && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) {
          setter.call(el, v);
        } else {
          el.value = v;
        }
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }, [idx, text]);
      return sendJson(res, 200, { ok: true });
    }

    // ---- POST /press {key} ----
    if (req.method === 'POST' && url.pathname === '/press') {
      const { key } = await readBody(req);
      const p = await ensureBrowser();
      await p.keyboard.press(key || 'Enter');
      await p.waitForTimeout(500);
      return sendJson(res, 200, { ok: true });
    }

    // ---- GET /screenshot ----
    if (req.method === 'GET' && url.pathname === '/screenshot') {
      const p = await ensureBrowser();
      const buf = await p.screenshot({ type: 'png' });
      res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': buf.length });
      return res.end(buf);
    }

    return sendJson(res, 404, { error: 'not_found' });
  } catch (e) {
    console.error('[driver] error:', e.message);
    return sendJson(res, 500, { error: 'driver_error', message: e.message.slice(0, 200) });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('[driver] listening on 127.0.0.1:' + PORT);
  // 开机即启动浏览器（非懒加载）："一台电脑"体验，ps 能看到 chrome 进程
  ensureBrowser().then(() => {
    console.log('[driver] browser auto-started at boot');
  }).catch((e) => {
    console.error('[driver] browser auto-start failed:', e.message);
  });
});

// 优雅退出
process.on('SIGTERM', async () => {
  try { if (context) await context.close(); } catch (_) {}
  process.exit(0);
});
