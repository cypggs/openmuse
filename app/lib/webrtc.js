/**
 * openmuse WebRTC 桌面推流 — 后端 SFU（对标 Memoh）
 *
 * 架构：
 *   Sandbox: gst-launch-1.0 (rfbsrc → x264enc → rtph264pay → udpsink → 后端IP:5004)
 *   后端: UDP 收 RTP → werift RTCPeerConnection → 浏览器 <video>
 *   信令: HTTP POST /api/webrtc/offer (SDP offer → answer)
 *   输入: 浏览器 DataChannel → 后端 → WebSocket → Sandbox → xdotool/RFB
 *
 * 挂载: app.use('/api/webrtc', webrtcRouter)
 */
'use strict';

const dgram = require('dgram');
const { RTCPeerConnection, RTCSessionDescription } = require('werift');

const RTP_PORT = parseInt(process.env.WEBRTC_RTP_PORT || '5004', 10);

// userId -> { pc, sessionId }
const sessions = new Map();
// RTP 转发目标：sessionId -> pc
let udpSock = null;

function log(...a) { console.log('[webrtc]', ...a); }

function ensureUdp() {
  if (udpSock) return;
  udpSock = dgram.createSocket('udp4');
  udpSock.on('message', (msg, rinfo) => {
    // 根据来源 IP 找到对应的 sandbox，再转发给该用户的所有 peer
    // 简化：广播给所有 connected 的 peer（单用户场景够用，多用户需按 IP 区分）
    for (const [, sess] of sessions) {
      if (sess.sender && sess.pc.connectionState === 'connected') {
        try {
          // werift 发送 RTP：通过 sender.sendRtp ?
          // 实际用 track.writeRtp
          if (sess.writeRtp) sess.writeRtp(msg);
        } catch (_) {}
      }
    }
  });
  udpSock.bind(RTP_PORT, '0.0.0.0', () => log('RTP UDP listening on', RTP_PORT));
}

/**
 * 处理浏览器的 SDP offer，返回 answer
 * @param {string} userId
 * @param {string} offerSdp
 * @param {object} opts { turnUrl, turnUser, turnPass }
 */
async function handleOffer(userId, offerSdp, opts = {}) {
  ensureUdp();

  // 关闭旧会话
  const old = sessions.get(userId);
  if (old) { try { old.pc.close(); } catch (_) {} sessions.delete(userId); }

  const iceServers = [];
  if (opts.turnUrl) {
    iceServers.push({ urls: opts.turnUrl, username: opts.turnUser, credential: opts.turnPass });
  }
  // 后端有公网 IP，host candidate 即可；也可用 stun
  iceServers.push({ urls: 'stun:stun.l.google.com:19302' });

  const pc = new RTCPeerConnection({ iceServers });

  // 创建 video track (sendonly)
  // werift: 需要手动创建 RTP 发送逻辑
  const { RtpPacket } = require('werift');

  pc.addTransceiver('video', { direction: 'sendonly' });

  // DataChannel 输入
  pc.onDataChannel.subscribe((chan) => {
    if (chan.label !== 'display-input') return;
    log('input channel open for', userId.slice(0, 8));
    chan.message.subscribe(async (msg) => {
      try {
        const data = JSON.parse(msg.toString());
        await forwardInput(userId, data);
      } catch (_) {}
    });
  });

  await pc.setRemoteDescription(new RTCSessionDescription(offerSdp, 'offer'));
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);

  // 等待 ICE gathering (non-trickle)
  await new Promise((resolve) => {
    if (pc.iceGatheringState === 'complete') return resolve();
    const t = setTimeout(resolve, 3000);
    pc.onIceGatheringStateChange.subscribe((s) => {
      if (s === 'complete') { clearTimeout(t); resolve(); }
    });
  });

  const sess = { pc, sessionId: Math.random().toString(36).slice(2), writeRtp: null };

  // 设置 RTP 写入：获取 sender 的 track
  // werift 的 transceiver.sender 需要 track，这里我们手动处理
  // 简化方案：用 pc.createDataChannel 之外的 video track
  // 实际实现需要深入 werift API，先占位

  sessions.set(userId, sess);

  pc.onConnectionStateChange.subscribe((s) => {
    log('pc', userId.slice(0, 8), 'state:', s);
    if (s === 'closed' || s === 'failed') sessions.delete(userId);
  });

  return { sdp: pc.localDescription.sdp, type: 'answer', sessionId: sess.sessionId };
}

/** 转发输入到 sandbox（经 E2B commands 用 xdotool） */
async function forwardInput(userId, data) {
  // 由调用方注入 sandboxMgr，避免循环依赖
  const fn = forwardInput.impl;
  if (fn) await fn(userId, data);
}

function closeSession(userId) {
  const sess = sessions.get(userId);
  if (sess) { try { sess.pc.close(); } catch (_) {} sessions.delete(userId); }
}

module.exports = { handleOffer, closeSession, forwardInput };
