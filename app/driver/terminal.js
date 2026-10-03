/**
 * openmuse 终端服务（对标 Memoh 的 terminal）
 *
 * 链路：WebSocket(:8890) <-> script(PTY) <-> bash
 * 用 `script -qec bash /dev/null` 提供 PTY，无需原生模块。
 *
 * 运行：node terminal.js (sandbox 内, TERM_PORT=8890)
 */
'use strict';

const http = require('http');
const { spawn } = require('child_process');

const TERM_PORT = parseInt(process.env.TERM_PORT || '8890', 10);

function log(...a) { console.log('[term]', ...a); }

// ---- 极简 WebSocket 服务器（复用 h264-stream.js 的实现） ----
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
  const client = { sock, buf: Buffer.alloc(0), pty: null };
  clients.add(client);
  log('ws client connected, total:', clients.size);

  // 为每个客户端 spawn 一个 PTY shell
  // script -qec 提供 PTY，-q 安静模式
  const pty = spawn('script', ['-qec', 'bash --login', '/dev/null'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, TERM: 'xterm-256color', PS1: '\\u@\\h:\\w\\$ ' },
  });
  client.pty = pty;
  log('pty spawned, pid:', pty.pid);

  pty.stdout.on('data', (d) => sendBinary(client, d));
  pty.stderr.on('data', (d) => sendBinary(client, d));
  pty.on('exit', (code) => {
    log('pty exited', code);
    sendText(client, '\r\n[process exited, reconnect to restart]\r\n');
    try { client.sock.destroy(); } catch (_) {}
  });
  pty.on('error', (e) => {
    log('pty error:', e.message);
    sendText(client, '\r\n[pty error: ' + e.message + ']\r\n');
  });

  // 欢迎信息
  sendText(client, '\r\n\x1b[1;36mopenmuse 云电脑终端\x1b[0m — 与 agent 共享同一台电脑\r\n');

  sock.on('data', (d) => handleWsFrame(client, d));
  sock.on('close', () => {
    clients.delete(client);
    try { pty.kill('SIGHUP'); } catch (_) {}
    log('ws client gone, total:', clients.size);
  });
  sock.on('error', () => {
    clients.delete(client);
    try { pty.kill('SIGHUP'); } catch (_) {}
  });
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
    if (opcode === 0x8) { client.sock.destroy(); return; }
    if (opcode === 0x2 || opcode === 0x1) {
      // 二进制或文本：直接写入 PTY
      if (opcode === 0x1) {
        try {
          const msg = JSON.parse(payload.toString());
          if (msg.type === 'resize') {
            continue;
          }
        } catch (_) { /* 不是 JSON，当普通输入 */ }
      }
      if (client.pty && !client.pty.killed) {
        try {
          client.pty.stdin.write(payload);
          // 调试：记录收到的输入（仅前 20 字符）
          // log('pty input:', JSON.stringify(payload.toString().slice(0, 20)));
        } catch (e) { log('pty write fail:', e.message); }
      } else {
        log('pty not ready, dropping input');
      }
    }
  }
}

function sendFrame(client, opcode, data) {
  if (client.sock.destroyed) return;
  const h = Buffer.alloc(2);
  h[0] = 0x80 | opcode;
  if (data.length < 126) {
    h[1] = data.length;
    client.sock.write(Buffer.concat([h, data]));
  } else {
    const e = Buffer.alloc(4);
    e[0] = 0x80 | opcode; e[1] = 126;
    e.writeUInt16BE(data.length, 2);
    client.sock.write(Buffer.concat([e, data]));
  }
}
function sendBinary(client, data) { sendFrame(client, 0x2, Buffer.from(data)); }
function sendText(client, str) { sendFrame(client, 0x1, Buffer.from(str)); }

// ---- HTTP + WS 服务器 ----
const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, clients: clients.size }));
    return;
  }
  res.writeHead(404); res.end();
});

server.on('upgrade', (req, sock) => {
  if (req.headers.upgrade !== 'websocket') { sock.destroy(); return; }
  handleWsHandshake(req, sock);
});

server.listen(TERM_PORT, '127.0.0.1', () => {
  log(`listening on 127.0.0.1:${TERM_PORT}`);
});
