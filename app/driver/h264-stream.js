/**
 * openmuse H264 桌面推流服务
 *
 * 视频：ximagesrc(:99 X11直采) → gst-launch-1.0 (x264enc → fdsink)
 *       → Node 读 H264 NAL → WebSocket (8889) → 浏览器 JMuxer(MSE) → <video>
 * 输入：
 *   - 鼠标：浏览器 → WebSocket → Node → xdotool → X11 XTEST
 *   - 键盘：浏览器 → WebSocket → Node → CDP (Chrome DevTools Protocol)
 *           → Chrome (Input.insertText / Input.dispatchKeyEvent)
 * （x11vnc 的 RFB 输入已废弃：其 XTEST 翻译对点击/特殊键失效；
 *   xdotool 的 XTEST 字符输入被 Chrome 屏蔽，故键盘走 CDP）
 */
'use strict';

const http = require('http');
const net = require('net');
const { spawn } = require('child_process');

const WS_PORT = parseInt(process.env.H264_PORT || '8889', 10);
const RFB_HOST = '127.0.0.1';
const RFB_PORT = 5900;

function log(...a) { console.log('[h264]', ...a); }

// ---- 极简 WebSocket 服务器（无依赖，手动实现 RFC6455） ----
const clients = new Set();

function handleWsHandshake(req, sock) {
  const key = req.headers['sec-websocket-key'];
  if (!key) { sock.destroy(); return; }
  const crypto = require('crypto');
  const accept = crypto.createHash('sha1')
    .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
    .digest('base64');
  sock.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );
  const client = { sock, buf: Buffer.alloc(0), gotHeaders: false };
  clients.add(client);
  log('ws client connected, total:', clients.size);
  // 注意：不再在首客户端时重启 gst（会导致重连恶性循环）。
  // 新客户端先发送缓存的 SPS/PPS，确保能解码；若缓存未就绪，等就绪后补发
  if (spsPpsCache) {
    try { sendBinary(client, spsPpsCache); } catch (_) {}
    client.gotHeaders = true;
  }
  // 若缓存未就绪，NAL 解析器在拿到 SPS/PPS 后会补发（见 gst.stdout.on）
  sock.on('data', (d) => handleWsFrame(client, d));
  sock.on('close', () => { clients.delete(client); log('ws client gone, total:', clients.size); });
  sock.on('error', () => { clients.delete(client); });
}

function handleWsFrame(client, data) {
  client.buf = Buffer.concat([client.buf, data]);
  while (client.buf.length >= 2) {
    const b0 = client.buf[0], b1 = client.buf[1];
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f, off = 2;
    if (len === 126) { len = client.buf.readUInt16BE(2); off = 4; }
    else if (len === 127) { len = Number(client.buf.readBigUInt64BE(2)); off = 10; }
    const maskOff = masked ? 4 : 0;
    if (client.buf.length < off + maskOff + len) break;
    let payload = client.buf.slice(off + maskOff, off + maskOff + len);
    if (masked) {
      const mask = client.buf.slice(off, off + 4);
      payload = Buffer.from(payload.map((b, i) => b ^ mask[i % 4]));
    }
    client.buf = client.buf.slice(off + maskOff + len);
    if (opcode === 0x8) { client.sock.destroy(); return; } // close
    if (opcode === 0x1) handleInput(payload.toString()); // text = input JSON
    // ping/pong 忽略
  }
}

function sendBinary(client, data) {
  const h = Buffer.alloc(2);
  h[0] = 0x82; // binary, fin
  if (data.length < 126) { h[1] = data.length; client.sock.write(Buffer.concat([h, data])); }
  else { const e = Buffer.alloc(4); e[0] = 0x82; e[1] = 126; e.writeUInt16BE(data.length, 2); client.sock.write(Buffer.concat([e, data])); }
}

function broadcastH264(nal) {
  for (const c of clients) {
    try { sendBinary(c, nal); } catch (_) { clients.delete(c); }
  }
}

// SPS/PPS 缓存（模块级，供新客户端使用）
let spsPpsCache = null;
let nalBuf = Buffer.alloc(0);

// ---- 输入 ----
// 全走 xdotool 直驱 X11 XTEST，不再用 RFB→x11vnc。
// 原因：x11vnc 能收到 RFB 事件但翻译到 X11 时静默失效
// （moves/clicks/特殊键均无反应），而 xdotool 直驱已验证有效。
// 用持久化 bash 进程避免每次 spawn 开销。
let xdotoolProc = null;
// RFB（仅用于可打印字符的 KeyEvent，x11vnc 对普通字符翻译正常）
let rfbSock = null, rfbReady = false;
function ensureXdotool() {
  if (xdotoolProc && !xdotoolProc.killed) return xdotoolProc;
  const { spawn } = require('child_process');
  xdotoolProc = spawn('bash', [], {
    env: { ...process.env, DISPLAY: ':99' },
    stdio: ['pipe', 'ignore', 'ignore'],
  });
  xdotoolProc.on('exit', () => { xdotoolProc = null; });
  xdotoolProc.on('error', () => { xdotoolProc = null; });
  return xdotoolProc;
}
function xdotool(cmd) {
  try {
    const p = ensureXdotool();
    if (p && p.stdin.writable) {
      // 临时调试：记录 key/click 命令
      if (cmd.startsWith('key ') || cmd.includes('click')) log('[xdotool]', cmd);
      p.stdin.write('xdotool ' + cmd + '\n');
    }
  } catch (e) { log('xdotool fail:', e.message); }
}
// keysym → xdotool key 名
const KEYSYM_TO_XDOTOOL = {
  0xff08: 'BackSpace', 0xff09: 'Tab', 0xff0d: 'Return', 0xff1b: 'Escape',
  0xffff: 'Delete', 0xff50: 'Home', 0xff57: 'End',
  0xff51: 'Left', 0xff52: 'Up', 0xff53: 'Right', 0xff54: 'Down',
  0xffe1: 'Shift_L', 0xffe3: 'Control_L', 0xffe9: 'Alt_L', 0xffe7: 'Super_L',
  0x20: 'space',
};

// ---- CDP 键盘输入 ----
// Chrome 屏蔽 XTEST 合成的字符输入，故键盘走 CDP。
// 极简 WS 客户端（Node 无内置 ws 库，手写握手+帧）。
let cdpSock = null, cdpId = 0;
const cdpPending = new Map();
function cdpSend(method, params = {}) {
  return new Promise((resolve, reject) => {
    if (!cdpSock || cdpSock.destroyed) return reject(new Error('cdp not connected'));
    const id = ++cdpId;
    cdpPending.set(id, { resolve, reject });
    const payload = Buffer.from(JSON.stringify({ id, method, params }));
    // WS client frame: FIN+text, masked
    const mask = require('crypto').randomBytes(4);
    const header = Buffer.alloc(6);
    header[0] = 0x81;
    header[1] = 0x80 | payload.length;
    mask.copy(header, 2);
    const masked = Buffer.from(payload.map((b, i) => b ^ mask[i % 4]));
    cdpSock.write(Buffer.concat([header, masked]));
    setTimeout(() => {
      if (cdpPending.has(id)) { cdpPending.delete(id); reject(new Error('cdp timeout')); }
    }, 5000);
  });
}
function ensureCdp() {
  if (cdpSock && !cdpSock.destroyed) return Promise.resolve();
  log('[cdp] connecting...');
  return new Promise((resolve, reject) => {
    const http = require('http');
    http.get('http://127.0.0.1:9222/json/list', (res) => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        try {
          const tabs = JSON.parse(body);
          if (!tabs.length) return reject(new Error('no tabs'));
          const wsUrl = tabs[0].webSocketDebuggerUrl;
          const m = wsUrl.match(/ws:\/\/127\.0\.0\.1:9222(\/devtools\/page\/.+)/);
          if (!m) return reject(new Error('bad ws url'));
          const path = m[1];
          const net = require('net');
          const crypto = require('crypto');
          const key = crypto.randomBytes(16).toString('base64');
          const sock = net.createConnection({ host: '127.0.0.1', port: 9222 }, () => {
            sock.write(
              `GET ${path} HTTP/1.1\r\n` +
              `Host: 127.0.0.1:9222\r\n` +
              `Upgrade: websocket\r\n` +
              `Connection: Upgrade\r\n` +
              `Sec-WebSocket-Key: ${key}\r\n` +
              `Sec-WebSocket-Version: 13\r\n\r\n`
            );
          });
          let hs = '', hsDone = false, buf = Buffer.alloc(0);
          sock.on('data', (d) => {
            if (!hsDone) {
              hs += d.toString();
              if (hs.includes('\r\n\r\n')) { hsDone = true; cdpSock = sock; resolve(); }
              return;
            }
            buf = Buffer.concat([buf, d]);
            // 解析 WS server frame（不 masked）
            while (buf.length >= 2) {
              const b0 = buf[0], b1 = buf[1];
              const opcode = b0 & 0x0f;
              let len = b1 & 0x7f, off = 2;
              if (len === 126) { len = buf.readUInt16BE(2); off = 4; }
              else if (len === 127) { len = Number(buf.readBigUInt64BE(2)); off = 10; }
              if (buf.length < off + len) break;
              const payload = buf.slice(off, off + len);
              buf = buf.slice(off + len);
              if (opcode === 0x1) {
                try {
                  const msg = JSON.parse(payload.toString());
                  if (msg.id && cdpPending.has(msg.id)) {
                    const { resolve, reject } = cdpPending.get(msg.id);
                    cdpPending.delete(msg.id);
                    if (msg.error) reject(new Error(msg.error.message));
                    else resolve(msg.result);
                  }
                } catch (_) {}
              }
            }
          });
          sock.on('error', (e) => { cdpSock = null; reject(e); });
          sock.on('close', () => { cdpSock = null; });
          setTimeout(() => reject(new Error('cdp connect timeout')), 8000);
        } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}
// keysym → CDP key 名
const KEYSYM_TO_CDP = {
  0xff08: 'Backspace', 0xff09: 'Tab', 0xff0d: 'Enter', 0xff1b: 'Escape',
  0xffff: 'Delete', 0xff50: 'Home', 0xff57: 'End',
  0xff51: 'ArrowLeft', 0xff52: 'ArrowUp', 0xff53: 'ArrowRight', 0xff54: 'ArrowDown',
};
async function cdpKey(keysym, down) {
  try {
    await ensureCdp();
    const ks = keysym >>> 0;
    const cdpKeyName = KEYSYM_TO_CDP[ks];
    const type = down ? 'keyDown' : 'keyUp';
    if (cdpKeyName) {
      // 特殊键
      await cdpSend('Input.dispatchKeyEvent', { type, key: cdpKeyName });
    } else if (ks >= 32 && ks < 127) {
      // 可打印 ASCII：先 keyDown，再 char（CDP 的 char 类型用于文本输入）
      const ch = String.fromCharCode(ks);
      let vk = ks;
      if (ks >= 97 && ks <= 122) vk = ks - 32;
      if (down) {
        await cdpSend('Input.dispatchKeyEvent', {
          type: 'keyDown', key: ch, windowsVirtualKeyCode: vk, text: ch, unmodifiedText: ch,
        });
        await cdpSend('Input.dispatchKeyEvent', { type: 'char', text: ch, unmodifiedText: ch });
      } else {
        await cdpSend('Input.dispatchKeyEvent', { type: 'keyUp', key: ch, windowsVirtualKeyCode: vk });
      }
    }
  } catch (e) { log('cdpKey fail:', e.message); }
}

async function handleInput(json) {
  try {
    const m = JSON.parse(json);
    if (m.type === 'key') log('[input] key', m.keysym, m.down);
    if (m.type === 'pointer') {
      const mask = m.buttonMask | 0;
      const x = m.x | 0, y = m.y | 0;
      if (mask !== 0) {
        // 点击走 xdotool（RFB button press 经 x11vnc 失效）
        const btn = mask === 4 ? 3 : mask === 2 ? 2 : 1;
        xdotool(`mousemove ${x} ${y} click ${btn}`);
      } else {
        // 纯移动走 RFB（低延迟，x11vnc 对移动事件翻译正常）
        await ensureRfb().catch((e) => log('rfb connect fail:', e.message));
        if (!rfbReady || !rfbSock) { log('rfb not ready, drop move'); return; }
        const b = Buffer.alloc(6);
        b[0] = 5; b[1] = 0;
        b.writeUInt16BE(x, 2); b.writeUInt16BE(y, 4);
        try { rfbSock.write(b); } catch (e) {
          log('rfb write fail:', e.message);
          rfbReady = false; rfbSock = null; ensureRfb._pending = null;
        }
      }
    } else if (m.type === 'key') {
      const ks = m.keysym >>> 0;
      // 可打印字符走 RFB（x11vnc 对普通字符的 XTEST 翻译正常）
      // 特殊键走 xdotool（RFB 0xFFxx 经 x11vnc 失效，但 xdotool 直驱有效）
      if (ks < 128) {
        await ensureRfb().catch((e) => log('rfb connect fail:', e.message));
        if (!rfbReady || !rfbSock) { log('rfb not ready, drop key'); return; }
        const b = Buffer.alloc(8);
        b[0] = 4; b[1] = m.down ? 1 : 0; b.writeUInt32BE(ks, 4);
        try { rfbSock.write(b); } catch (e) {
          log('rfb write fail:', e.message);
          rfbReady = false; rfbSock = null; ensureRfb._pending = null;
        }
      } else {
        // 特殊键走 xdotool
        const xkey = KEYSYM_TO_XDOTOOL[ks];
        if (xkey && m.down) xdotool(`key ${xkey}`);
      }
    }
  } catch (e) { log('handleInput err:', e.message); }
}
function ensureRfb() {
  // 如果 socket 不可写，视为已死，强制重建
  if (rfbSock && !rfbSock.writable) {
    log('rfb sock not writable, resetting');
    rfbReady = false; rfbSock = null; ensureRfb._pending = null;
  }
  if (rfbReady) return Promise.resolve();
  if (ensureRfb._pending) return ensureRfb._pending;
  ensureRfb._pending = new Promise((resolve, reject) => {
    const s = net.createConnection({ host: RFB_HOST, port: RFB_PORT }, () => {
      let stage = 0, buf = Buffer.alloc(0);
      const timer = setTimeout(() => { s.destroy(); reject(new Error('rfb timeout')); }, 8000);
      s.on('data', (d) => {
        buf = Buffer.concat([buf, d]);
        try {
          if (stage === 0 && buf.length >= 12) {
            // Server version → 回写相同版本（x11vnc 发 RFB 003.008）
            s.write(buf.slice(0, 12)); buf = buf.slice(12); stage = 1;
          }
          if (stage === 1 && buf.length >= 2) {
            // RFB 3.8 安全协商：1 字节类型数量 + N 字节类型列表
            // x11vnc -nopw 发 01 01（1 种类型：None=1）
            const nTypes = buf[0];
            if (buf.length < 1 + nTypes) return; // 等收齐
            const types = Array.from(buf.slice(1, 1 + nTypes));
            buf = buf.slice(1 + nTypes);
            if (!types.includes(1)) {
              clearTimeout(timer); s.destroy();
              return reject(new Error('rfb no None auth, types=' + types.join(',')));
            }
            s.write(Buffer.from([1])); // 选择 None
            stage = 2; // 等 SecurityResult（4 字节）
          }
          if (stage === 2 && buf.length >= 4) {
            const secResult = buf.readUInt32BE(0); buf = buf.slice(4);
            if (secResult !== 0) { clearTimeout(timer); s.destroy(); return reject(new Error('rfb security result=' + secResult)); }
            s.write(Buffer.from([1])); // ClientInit: shared
            stage = 3;
          }
          if (stage === 3 && buf.length >= 24) {
            // ServerInit 前 24 字节已到（后面还有 name，忽略）
            clearTimeout(timer);
            rfbSock = s; rfbReady = true;
            s.removeAllListeners('data');
            const onDead = () => {
              if (rfbSock === s) {
                log('rfb socket dead, will reconnect on next input');
                rfbReady = false; rfbSock = null; ensureRfb._pending = null;
              }
            };
            s.on('error', onDead);
            s.on('close', onDead);
            log('rfb ready');
            resolve();
          }
        } catch (e) { clearTimeout(timer); reject(e); }
      });
      s.on('error', (e) => { clearTimeout(timer); reject(e); });
    });
  }).finally(() => { ensureRfb._pending = null; });
  return ensureRfb._pending;
}

// ---- GStreamer ----
// 视频直采：ximagesrc 直接从 X11 抓屏，不经过 x11vnc/RFB。
// 原因：x11vnc 的 XDamage 跟踪会间歇性坏掉（返回 0 rects），导致视频黑屏。
// ximagesrc 用 X11 原生抓屏，更稳定。
// 注意：本机 x264enc 不支持 repeat-headers，SPS/PPS 只在流开头发送一次。
// 因此首个客户端连接时重启 gst，确保新客户端能拿到 SPS/PPS 完成解码。
let gstProc = null;
function startGst() {
  // gst 重启时清空 SPS/PPS 缓存和 NAL 缓冲，新流的头会被重新缓存
  spsPpsCache = null;
  nalBuf = Buffer.alloc(0);
  // 旧客户端标记为未拿头，新流开始后会补发
  for (const c of clients) c.gotHeaders = false;
  const args = [
    '-q',
    'ximagesrc', 'display-name=:99', 'show-pointer=true', 'use-damage=false',
    '!', 'videoconvert',
    '!', 'videorate', '!', 'video/x-raw,framerate=15/1',
    '!', 'queue', 'leaky=downstream', 'max-size-buffers=2',
    '!', 'x264enc', 'tune=zerolatency', 'speed-preset=ultrafast',
    'bframes=0', 'key-int-max=30', 'byte-stream=true',
    '!', 'fdsink', 'fd=1',
  ];
  log('starting gst-launch-1.0');
  // ximagesrc 需要 DISPLAY 才能连上 X11
  const gst = spawn('gst-launch-1.0', args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, DISPLAY: ':99' },
  });
  gstProc = gst;
  gst.stderr.on('data', d => {
    const s = d.toString().trim();
    if (s && !s.includes('WARNING') && s.length < 300) log('[gst]', s.slice(0, 150));
  });
  gst.on('exit', (c) => {
    if (gstProc === gst) gstProc = null;
    log('gst exited', c, 'restarting in 2s'); setTimeout(startGst, 2000);
  });

  // 直接转发原始 H264 字节流（Annex B），前端 JMuxer 负责解析
  // 不做 NAL 切分，避免解析 bug
  // NAL 解析：缓存 SPS/PPS，新客户端先发送（spsPpsCache/nalBuf 为模块级变量）
  gst.stdout.on('data', (d) => {
    if (clients.size === 0) return;
    nalBuf = Buffer.concat([nalBuf, d]);
    // 按 Annex B 起始码切分 NAL
    const nals = [];
    let start = 0;
    for (let i = 0; i < nalBuf.length - 3; i++) {
      if (nalBuf[i] === 0 && nalBuf[i+1] === 0) {
        let scLen = 0;
        if (nalBuf[i+2] === 1) scLen = 3;
        else if (i+3 < nalBuf.length && nalBuf[i+2] === 0 && nalBuf[i+3] === 1) scLen = 4;
        if (scLen > 0) {
          if (i > start) nals.push(nalBuf.slice(start, i));
          start = i;
          i += scLen - 1;
        }
      }
    }
    // 保留最后一个不完整的 NAL
    const remaining = nalBuf.slice(start);
    nalBuf = remaining;
    // 缓存 SPS/PPS（NAL type 7 和 8）
    if (!spsPpsCache) {
      for (const nal of nals) {
        const scLen = (nal[2] === 1) ? 3 : 4;
        const type = nal[scLen] & 0x1f;
        if (type === 7 || type === 8) {
          if (!spsPpsCache) spsPpsCache = [];
          spsPpsCache.push(nal);
          if (spsPpsCache.length >= 2) {
            spsPpsCache = Buffer.concat(spsPpsCache);
            // 补发给已连接但没拿到头的客户端
            for (const c of clients) {
              if (!c.gotHeaders) {
                try { sendBinary(c, spsPpsCache); } catch (_) {}
                c.gotHeaders = true;
              }
            }
            break;
          }
        }
      }
    }
    // 广播所有完整 NAL
    for (const nal of nals) broadcastH264(nal);
  });
}

// ---- HTTP + WS 服务器 ----
const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, clients: clients.size, gst: true }));
    return;
  }
  res.writeHead(404); res.end();
});

server.on('upgrade', (req, sock) => {
  if (req.headers.upgrade !== 'websocket') { sock.destroy(); return; }
  handleWsHandshake(req, sock);
});

server.listen(WS_PORT, '127.0.0.1', () => {
  log(`listening on 127.0.0.1:${WS_PORT}`);
  startGst();
});
