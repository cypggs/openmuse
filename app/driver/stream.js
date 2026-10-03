/**
 * openmuse WebRTC 桌面推流服务（对标 Memoh）
 *
 * 链路：x11vnc(:5900 RFB) → gst-launch-1.0 (rfbsrc → x264enc → rtph264pay → udpsink)
 *       → Node UDP 读 RTP → werift RTCPeerConnection → 浏览器 <video>
 * 信令：HTTP POST /webrtc/offer (SDP offer → answer, non-trickle ICE)
 * 输入：WebRTC DataChannel 'display-input' → RFB PointerEvent/KeyEvent → x11vnc
 *
 * 运行：node stream.js (sandbox 内, PORT=8889)
 */
'use strict';

const http = require('http');
const dgram = require('dgram');
const net = require('net');
const { spawn } = require('child_process');
const { RTCPeerConnection, RTCSessionDescription } = require('werift');

const PORT = parseInt(process.env.STREAM_PORT || '8889', 10);
const RFB_HOST = '127.0.0.1';
const RFB_PORT = 5900;
const RTP_PORT = 5004; // GStreamer udpsink 目标端口
const TURN_URL = process.env.TURN_URL || ''; // e.g. turn:1.2.3.4:3478
const TURN_USER = process.env.TURN_USER || '';
const TURN_PASS = process.env.TURN_PASS || '';

let gstProc = null;
let udpSock = null;
let pcs = new Map(); // sessionId -> { pc, track }

function log(...a) { console.log('[stream]', ...a); }

/** 启动 GStreamer pipeline（单例） */
function ensureGStreamer() {
  if (gstProc && !gstProc.killed) return;
  const args = [
    '-q',
    'rfbsrc', `host=${RFB_HOST}`, `port=${RFB_PORT}`, 'shared=true',
    'incremental=false', 'use-copyrect=true', 'do-timestamp=true',
    '!', 'videoconvert',
    '!', 'videorate',
    '!', 'video/x-raw,framerate=15/1',
    '!', 'queue', 'leaky=downstream', 'max-size-buffers=2',
    '!', 'x264enc', 'tune=zerolatency', 'speed-preset=ultrafast',
    'bframes=0', 'key-int-max=30', 'byte-stream=true',
    '!', 'video/x-h264,profile=baseline,stream-format=byte-stream,alignment=au',
    '!', 'h264parse', 'config-interval=-1',
    '!', 'rtph264pay', 'aggregate-mode=zero-latency', 'config-interval=-1', 'pt=102',
    '!', 'udpsink', 'host=127.0.0.1', `port=${RTP_PORT}`, 'sync=false', 'async=false',
  ];
  log('starting gst-launch-1.0...');
  gstProc = spawn('gst-launch-1.0', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  gstProc.stderr.on('data', d => {
    const s = d.toString().trim();
    if (s && !s.includes('WARNING')) log('[gst]', s.slice(0, 200));
  });
  gstProc.on('exit', (code) => { log('gst exited', code); gstProc = null; });
}

/** UDP 监听 RTP，转发给所有 peer 的 video track */
function ensureUdp() {
  if (udpSock) return;
  udpSock = dgram.createSocket('udp4');
  udpSock.on('message', (msg) => {
    // RTP 包直接写入每个 peer 的 track
    for (const [, sess] of pcs) {
      if (sess.track && sess.pc.connectionState === 'connected') {
        try { sess.track.writeRtp(msg); } catch (_) {}
      }
    }
  });
  udpSock.bind(RTP_PORT, '127.0.0.1', () => log('UDP listening on', RTP_PORT));
}

/** 极简 RFB 客户端（只做输入） */
class RfbInput {
  constructor() { this.sock = null; this.ready = false; }
  async connect() {
    if (this.ready) return;
    return new Promise((resolve, reject) => {
      const s = net.createConnection({ host: RFB_HOST, port: RFB_PORT }, () => {
        // RFB 握手：读 server version, 回 client version, 读 auth, 发 ClientInit
        let stage = 0;
        let buf = Buffer.alloc(0);
        s.on('data', (d) => {
          buf = Buffer.concat([buf, d]);
          if (stage === 0 && buf.length >= 12) {
            // Server: "RFB 003.008\n" → 回 "RFB 003.008\n"
            s.write(buf.slice(0, 12)); buf = buf.slice(12); stage = 1;
          } else if (stage === 1 && buf.length >= 4) {
            // auth scheme (4 bytes)
            const scheme = buf.readUInt32BE(0); buf = buf.slice(4);
            if (scheme !== 1) { s.destroy(); return reject(new Error('auth required')); }
            stage = 2;
            s.write(Buffer.from([1])); // ClientInit: shared
          } else if (stage === 2 && buf.length >= 24) {
            // ServerInit (跳过), 发 SetEncodings (空) + 完成
            this.sock = s; this.ready = true;
            s.removeAllListeners('data');
            resolve();
          }
        });
        s.on('error', reject);
        setTimeout(() => reject(new Error('rfb handshake timeout')), 5000);
      });
    });
  }
  pointer(x, y, mask) {
    if (!this.ready) return;
    const b = Buffer.alloc(6);
    b[0] = 5; b[1] = mask; b.writeUInt16BE(x, 2); b.writeUInt16BE(y, 4);
    this.sock.write(b);
  }
  key(keysym, down) {
    if (!this.ready) return;
    const b = Buffer.alloc(8);
    b[0] = 4; b[1] = down ? 1 : 0; b.writeUInt32BE(keysym, 4);
    this.sock.write(b);
  }
}
const rfb = new RfbInput();

async function handleOffer(offerSdp) {
  ensureGStreamer();
  ensureUdp();
  try { await rfb.connect(); } catch (e) { log('rfb connect failed:', e.message); }

  const iceServers = [];
  if (TURN_URL) iceServers.push({ urls: TURN_URL, username: TURN_USER, credential: TURN_PASS });

  const pc = new RTCPeerConnection({ iceServers });
  const sessionId = Math.random().toString(36).slice(2);

  // Video track (sendonly)
  const track = new (require('werift').RtpTrack)({ kind: 'video', codec: 'H264', clockRate: 90000 });
  // 实际上用 TrackLocalStaticRTP 更合适，这里简化
  const transceiver = pc.addTransceiver('video', { direction: 'sendonly' });

  // DataChannel for input
  pc.onDataChannel.subscribe((chan) => {
    if (chan.label !== 'display-input') return;
    log('datachannel open:', chan.label);
    chan.message.subscribe((msg) => {
      try {
        const data = JSON.parse(msg.toString());
        if (data.type === 'pointer') rfb.pointer(data.x | 0, data.y | 0, data.buttonMask | 0);
        else if (data.type === 'key') rfb.key(data.keysym >>> 0, !!data.down);
      } catch (_) {}
    });
  });

  await pc.setRemoteDescription(new RTCSessionDescription(offerSdp, 'offer'));
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);

  // 等待 ICE gathering 完成 (non-trickle)
  await new Promise((resolve) => {
    if (pc.iceGatheringState === 'complete') return resolve();
    const t = setTimeout(resolve, 3000);
    pc.onIceGatheringStateChange.subscribe((s) => {
      if (s === 'complete') { clearTimeout(t); resolve(); }
    });
  });

  // 获取带 candidate 的 SDP
  const localSdp = pc.localDescription.sdp;

  // RTP 转发：需要把 UDP 的 RTP 包写入 track
  // werift 的 track 需要正确设置，这里用一个简单的方式
  pcs.set(sessionId, { pc, track: transceiver.sender });

  pc.onConnectionStateChange.subscribe((s) => {
    log('connection state:', s);
    if (s === 'closed' || s === 'failed') {
      pcs.delete(sessionId);
      try { pc.close(); } catch (_) {}
    }
  });

  return { sdp: localSdp, type: 'answer', sessionId };
}

// HTTP 信令服务器
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  if (req.url === '/health' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, sessions: pcs.size }));
    return;
  }

  if (req.url === '/webrtc/offer' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const { sdp } = JSON.parse(body);
        const answer = await handleOffer(sdp);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(answer));
      } catch (e) {
        log('offer failed:', e.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  res.writeHead(404); res.end('not found');
});

server.listen(PORT, '127.0.0.1', () => {
  log(`listening on 127.0.0.1:${PORT}`);
});
