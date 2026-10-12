/**
 * openmuse H264 桌面推流服务（对标 Memoh 的 GStreamer pipeline）
 *
 * 链路：ximagesrc(:99 X11直采) → gst-launch-1.0 (x264enc → fdsink)
 *       → Node 读 H264 NAL → WebSocket (8889) → 浏览器 JMuxer(MSE) → <video>
 * 输入：浏览器 → WebSocket → Node RFB客户端 → x11vnc(:5900) → XTEST → X11
 * (视频不走 x11vnc：其 XDamage 跟踪会间歇性坏掉导致黑屏)
 * 输入：WebSocket JSON → RFB PointerEvent/KeyEvent → x11vnc
 *
 * GStreamer pipeline 与 Memoh 的 H264 分支一致（除了末端用 fdsink 不用 udpsink）：
 *   rfbsrc host=127.0.0.1 port=5900 shared=true incremental=false use-copyrect=true do-timestamp=true
 *   ! videoconvert ! videorate ! video/x-raw,framerate=15/1
 *   ! queue leaky=downstream max-size-buffers=2
 *   ! x264enc tune=zerolatency speed-preset=ultrafast bframes=0 key-int-max=30 byte-stream=true
 *   ! video/x-h264,profile=baseline,stream-format=byte-stream,alignment=au
 *   ! fdsink fd=1
 * （注：已去掉 h264parse——输出 Annex B 直给 JMuxer；avcC 转换会导致黑屏，见 commit 0e4880d）
 *
 * 运行：node h264-stream.js (sandbox 内, WS_PORT=8889)
 * 传输层预留 WebRTC 替换位（当前用 WebSocket 穿 E2B HTTP 代理）。
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
  // 新客户端等待下一个关键帧即可（key-int-max=30，15fps 下最多 2 秒）。
  // 若 x264enc 支持 repeat-headers 可更优，但本机不支持。
  // 新客户端先发送缓存的 SPS/PPS 头，确保能解码；若缓存未就绪，等就绪后补发
  if (broadcastH264.cache && broadcastH264.headerDone) {
    for (const h of broadcastH264.cache) {
      try { sendBinary(client, h); } catch (_) {}
    }
    client.gotHeaders = true;
  }
  // 若缓存未就绪，broadcastH264 在缓存满 5 个时会补发（见上）
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
  // 缓存流开头的 SPS/PPS（前几个 NAL），新客户端连接时先发送
  if (!broadcastH264.headerDone) {
    if (!broadcastH264.cache) broadcastH264.cache = [];
    broadcastH264.cache.push(nal);
    // 缓存前 5 个 NAL（应包含 SPS/PPS/IDR），之后不再缓存
    if (broadcastH264.cache.length >= 5) {
      broadcastH264.headerDone = true;
      // 缓存就绪，补发给之前连上但没拿到头的客户端
      for (const c of clients) {
        if (!c.gotHeaders) {
          for (const h of broadcastH264.cache) {
            try { sendBinary(c, h); } catch (_) {}
          }
          c.gotHeaders = true;
        }
      }
    }
  }
  for (const c of clients) {
    try { sendBinary(c, nal); } catch (_) { clients.delete(c); }
  }
}

// ---- 输入 ----
// 全走 xdotool 直驱 X11 XTEST，不再用 RFB→x11vnc。
// 原因：x11vnc 能收到 RFB 事件但翻译到 X11 时静默失效
// （moves/clicks/特殊键均无反应），而 xdotool 直驱已验证有效。
// 用持久化 bash 进程避免每次 spawn 开销。
let xdotoolProc = null;
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
    if (p && p.stdin.writable) p.stdin.write('xdotool ' + cmd + '\n');
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

async function handleInput(json) {
  try {
    const m = JSON.parse(json);
    if (m.type === 'pointer') {
      const mask = m.buttonMask | 0;
      const x = m.x | 0, y = m.y | 0;
      if (mask !== 0) {
        // 点击：移动+点击
        const btn = mask === 4 ? 3 : mask === 2 ? 2 : 1;
        xdotool(`mousemove ${x} ${y} click ${btn}`);
      } else {
        // 纯移动：节流，避免 xdotool 过载（每 30ms 最多一次）
        const now = Date.now();
        if (!handleInput._lastMove || now - handleInput._lastMove > 30) {
          handleInput._lastMove = now;
          xdotool(`mousemove ${x} ${y}`);
        }
      }
    } else if (m.type === 'key') {
      if (!m.down) return; // 只处理按下，xdotool key 自带 down+up
      const ks = m.keysym >>> 0;
      const xkey = KEYSYM_TO_XDOTOOL[ks];
      if (xkey) {
        xdotool(`key ${xkey}`);
      } else if (ks < 128) {
        // 可打印 ASCII：用 key 直接按字符（比 type 更可靠）
        const ch = String.fromCharCode(ks);
        // 转义特殊字符
        if (/[a-zA-Z0-9]/.test(ch)) {
          xdotool(`key ${ch}`);
        } else {
          xdotool(`type --delay 0 '${ch.replace(/'/g, "'\\''")}'`);
        }
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
  // gst 重启时清空 SPS/PPS 缓存，新流的头会被重新缓存
  broadcastH264.cache = null;
  broadcastH264.headerDone = false;
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
  gst.stdout.on('data', (d) => {
    if (clients.size > 0) broadcastH264(d);
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
