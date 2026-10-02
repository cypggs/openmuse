/**
 * openmuse H264 桌面推流服务（对标 Memoh 的 GStreamer pipeline）
 *
 * 链路：x11vnc(:5900 RFB) → gst-launch-1.0 (rfbsrc → x264enc → h264parse → fdsink)
 *       → Node 读 H264 NAL → WebSocket (8889) → 浏览器 WebCodecs → canvas
 * 输入：WebSocket JSON → RFB PointerEvent/KeyEvent → x11vnc
 *
 * GStreamer pipeline 与 Memoh 的 H264 分支一致（除了末端用 fdsink 不用 udpsink）：
 *   rfbsrc host=127.0.0.1 port=5900 shared=true incremental=false use-copyrect=true do-timestamp=true
 *   ! videoconvert ! videorate ! video/x-raw,framerate=15/1
 *   ! queue leaky=downstream max-size-buffers=2
 *   ! x264enc tune=zerolatency speed-preset=ultrafast bframes=0 key-int-max=30 byte-stream=true
 *   ! video/x-h264,profile=baseline,stream-format=byte-stream,alignment=au
 *   ! h264parse config-interval=-1 ! fdsink fd=1
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
  const client = { sock, buf: Buffer.alloc(0) };
  clients.add(client);
  log('ws client connected, total:', clients.size);
  sock.on('data', (d) => handleWsFrame(client, d));
  sock.on('close', () => { clients.delete(client); log('ws client gone, total:', clients.size); });
  sock.on('error', () => { clients.delete(client); });
  // 发送 SPS/PPS 配置（首个 IDR 前）
  if (spsPps) sendBinary(client, spsPps);
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

// ---- RFB 输入 ----
let rfbSock = null, rfbReady = false;
function ensureRfb() {
  if (rfbReady) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = net.createConnection({ host: RFB_HOST, port: RFB_PORT }, () => {
      let stage = 0, buf = Buffer.alloc(0);
      s.on('data', (d) => {
        buf = Buffer.concat([buf, d]);
        if (stage === 0 && buf.length >= 12) { s.write(buf.slice(0, 12)); buf = buf.slice(12); stage = 1; }
        else if (stage === 1 && buf.length >= 4) {
          if (buf.readUInt32BE(0) !== 1) { s.destroy(); return reject(new Error('auth')); }
          buf = buf.slice(4); stage = 2; s.write(Buffer.from([1]));
        } else if (stage === 2 && buf.length >= 24) {
          rfbSock = s; rfbReady = true; s.removeAllListeners('data'); resolve();
        }
      });
      s.on('error', reject);
      setTimeout(() => reject(new Error('rfb timeout')), 5000);
    });
  });
}

async function handleInput(json) {
  try {
    const m = JSON.parse(json);
    await ensureRfb().catch(() => {});
    if (!rfbReady) return;
    if (m.type === 'pointer') {
      const b = Buffer.alloc(6);
      b[0] = 5; b[1] = m.buttonMask | 0;
      b.writeUInt16BE(m.x | 0, 2); b.writeUInt16BE(m.y | 0, 4);
      rfbSock.write(b);
    } else if (m.type === 'key') {
      const b = Buffer.alloc(8);
      b[0] = 4; b[1] = m.down ? 1 : 0; b.writeUInt32BE(m.keysym >>> 0, 4);
      rfbSock.write(b);
    }
  } catch (_) {}
}

// ---- GStreamer ----
let spsPps = null;
function startGst() {
  const args = [
    '-q',
    'rfbsrc', `host=${RFB_HOST}`, `port=${RFB_PORT}`, 'shared=true',
    'incremental=false', 'use-copyrect=true', 'do-timestamp=true',
    '!', 'videoconvert',
    '!', 'videorate', '!', 'video/x-raw,framerate=15/1',
    '!', 'queue', 'leaky=downstream', 'max-size-buffers=2',
    '!', 'x264enc', 'tune=zerolatency', 'speed-preset=ultrafast',
    'bframes=0', 'key-int-max=30', 'byte-stream=true',
    '!', 'video/x-h264,profile=baseline,stream-format=byte-stream,alignment=au',
    '!', 'h264parse', 'config-interval=-1',
    '!', 'fdsink', 'fd=1',
  ];
  log('starting gst-launch-1.0');
  const gst = spawn('gst-launch-1.0', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  gst.stderr.on('data', d => {
    const s = d.toString().trim();
    if (s && !s.includes('WARNING') && s.length < 300) log('[gst]', s.slice(0, 150));
  });
  gst.on('exit', (c) => { log('gst exited', c, 'restarting in 2s'); setTimeout(startGst, 2000); });

  // 解析 H264 byte-stream，提取 NAL 单元
  let buf = Buffer.alloc(0);
  gst.stdout.on('data', (d) => {
    buf = Buffer.concat([buf, d]);
    // 按 start code (0x000001) 切分 NAL
    let start = 0;
    while (true) {
      const idx = buf.indexOf(Buffer.from([0, 0, 1]), start);
      if (idx < 0) break;
      if (start > 0 || idx > 0) {
        const nal = buf.slice(start === 0 ? 0 : start, idx);
        if (nal.length > 4) {
          const nalType = nal[3] & 0x1f; // 去掉 0x000001 前缀后的第一个字节
          // 7=SPS, 8=PPS, 5=IDR
          if (nalType === 7 || nalType === 8) {
            spsPps = spsPps ? Buffer.concat([spsPps, Buffer.from([0,0,1]), nal.slice(3)]) : nal;
          }
          if (clients.size > 0) broadcastH264(nal);
        }
      }
      start = idx + 3;
    }
    if (start > 0) buf = buf.slice(start);
    if (buf.length > 1024 * 1024) buf = buf.slice(-1024); // 防止内存泄漏
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
