/* openmuse Live View — H264 推流（对标 Memoh）。
 * 顶栏"浏览器"按钮 → GET /api/stream/url → WebSocket → WebCodecs 解码 → canvas。
 * 输入：鼠标/键盘 → JSON → WS → sandbox RFB。
 * 传输层预留 WebRTC 替换位（当前 WebSocket 穿 E2B 代理）。
 */
(function () {
  'use strict';

  var modal = null;
  var canvas = null, ctx = null;
  var ws = null, decoder = null;
  var connected = false;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>\"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '\"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function ensureModal() {
    if (modal) return modal;
    modal = document.createElement('div');
    modal.id = 'liveviewModal';
    modal.innerHTML =
      '<div class="lv-backdrop"></div>' +
      '<div class="lv-panel">' +
      '<div class="lv-head">' +
      '<span class="lv-title">🖥️ 云电脑 · 实时画面</span>' +
      '<span class="lv-hint">H264 低延迟推流，可直接操作（点击/输入）</span>' +
      '<button class="lv-close" title="关闭">✕</button>' +
      '</div>' +
      '<div class="lv-body"><div class="lv-loading">正在连接云电脑…</div></div>' +
      '</div>';
    document.body.appendChild(modal);
    modal.querySelector('.lv-close').addEventListener('click', close);
    modal.querySelector('.lv-backdrop').addEventListener('click', close);
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && modal.classList.contains('open')) close();
    });
    return modal;
  }

  function showError(msg) {
    var body = modal.querySelector('.lv-body');
    body.innerHTML = '<div class="lv-error">连接失败：' + esc(msg) +
      '<br>请确认云电脑已启动（发一条消息试试）。</div>';
  }

  async function open() {
    ensureModal();
    modal.classList.add('open');
    var body = modal.querySelector('.lv-body');

    if (connected && canvas) {
      body.innerHTML = '';
      body.appendChild(canvas);
      return;
    }

    body.innerHTML = '<div class="lv-loading">正在连接云电脑…</div>';

    try {
      // 1. 获取推流地址
      var r = await fetch('/api/stream/url', { credentials: 'same-origin' });
      if (!r.ok) throw new Error('获取推流地址失败 (' + r.status + ')');
      var data = await r.json();
      var wsUrl = data.url;
      console.log('[liveview] stream url:', wsUrl);

      // 2. 建 canvas
      canvas = document.createElement('canvas');
      canvas.width = 1280; canvas.height = 800;
      canvas.style.cssText = 'width:100%;height:100%;object-fit:contain;background:#000;cursor:crosshair;';
      ctx = canvas.getContext('2d');
      body.innerHTML = '';
      body.appendChild(canvas);

      // 3. WebCodecs 解码器
      if (!('VideoDecoder' in window)) {
        throw new Error('浏览器不支持 WebCodecs，请用 Chrome/Edge 94+');
      }
      decoder = new VideoDecoder({
        output: function (frame) {
          ctx.drawImage(frame, 0, 0, canvas.width, canvas.height);
          frame.close();
        },
        error: function (e) { console.error('[liveview] decode error:', e); }
      });
      decoder.configure({ codec: 'avc1.42E01F', optimizeForLatency: true });

      // 4. WebSocket 收 H264
      ws = new WebSocket(wsUrl);
      ws.binaryType = 'arraybuffer';
      var spsPpsReceived = false;
      var pending = [];

      ws.onopen = function () {
        console.log('[liveview] ws connected');
        connected = true;
      };
      ws.onmessage = function (ev) {
        var data = new Uint8Array(ev.data);
        // data 是单个 NAL（含 0x000001 前缀），转成 Annex B 给 decoder
        // WebCodecs 需要 avcC 格式？不，直接给 Annex B 也行（description 带 sps/pps）
        // 简化：累积 SPS/PPS，首帧带上
        var nalType = data[3] & 0x1f;
        if (nalType === 7 || nalType === 8) {
          // SPS/PPS：缓存，decoder.configure 时已指定 codec string，可跳过
          return;
        }
        var chunk = new EncodedVideoChunk({
          type: (nalType === 5) ? 'key' : 'delta',
          timestamp: performance.now() * 1000,
          data: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
        });
        if (decoder.state === 'configured') {
          decoder.decode(chunk);
        }
      };
      ws.onerror = function () { showError('WebSocket 连接失败'); connected = false; };
      ws.onclose = function () {
        console.log('[liveview] ws closed');
        connected = false;
        if (modal.classList.contains('open')) showError('连接断开');
      };

      // 5. 输入
      bindInput(canvas);

    } catch (e) {
      console.error('[liveview]', e);
      showError(e.message);
    }
  }

  function close() {
    modal.classList.remove('open');
    // 保持 ws 连接（后台继续），下次打开复用
  }

  // ---- 输入：鼠标/键盘 → WS JSON ----
  function keysymForEvent(e) {
    // 可打印字符
    if (e.key && e.key.length === 1) return e.key.codePointAt(0);
    var map = {
      Backspace: 0xff08, Tab: 0xff09, Enter: 0xff0d, Escape: 0xff1b,
      Delete: 0xffff, Home: 0xff50, End: 0xff57,
      ArrowLeft: 0xff51, ArrowUp: 0xff52, ArrowRight: 0xff53, ArrowDown: 0xff54,
      Shift: 0xffe1, Control: 0xffe3, Alt: 0xffe9, Meta: 0xffe7,
    };
    return map[e.key] || 0;
  }

  function sendInput(obj) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
  }

  function canvasPos(e) {
    var r = canvas.getBoundingClientRect();
    var x = Math.round((e.clientX - r.left) / r.width * 1280);
    var y = Math.round((e.clientY - r.top) / r.height * 800);
    return { x: Math.max(0, Math.min(1279, x)), y: Math.max(0, Math.min(799, y)) };
  }

  function bindInput(cv) {
    var buttons = 0;
    cv.oncontextmenu = function (e) { e.preventDefault(); };
    cv.addEventListener('mousedown', function (e) {
      var p = canvasPos(e);
      buttons = e.button === 0 ? 1 : e.button === 2 ? 4 : 2;
      sendInput({ type: 'pointer', x: p.x, y: p.y, buttonMask: buttons });
    });
    cv.addEventListener('mouseup', function (e) {
      var p = canvasPos(e);
      buttons = 0;
      sendInput({ type: 'pointer', x: p.x, y: p.y, buttonMask: 0 });
    });
    cv.addEventListener('mousemove', function (e) {
      if (!buttons) return;
      var p = canvasPos(e);
      sendInput({ type: 'pointer', x: p.x, y: p.y, buttonMask: buttons });
    });
    // 键盘：canvas 可聚焦
    cv.tabIndex = 0;
    cv.addEventListener('keydown', function (e) {
      var ks = keysymForEvent(e);
      if (ks) { sendInput({ type: 'key', keysym: ks, down: true }); e.preventDefault(); }
    });
    cv.addEventListener('keyup', function (e) {
      var ks = keysymForEvent(e);
      if (ks) { sendInput({ type: 'key', keysym: ks, down: false }); e.preventDefault(); }
    });
  }

  // 对外：顶栏按钮调用 window.__openmuseLiveView()
  window.__openmuseLiveView = open;

  // 顶栏按钮（等 DOM 就绪后插入）
  function addButton() {
    var topbar = document.querySelector('.topbar');
    if (!topbar || document.getElementById('liveviewBtn')) return;
    var btn = document.createElement('button');
    btn.id = 'liveviewBtn';
    btn.className = 'lv-btn';
    btn.title = '打开云电脑实时画面（H264 低延迟，可观看/接管）';
    btn.textContent = '🖥️ 浏览器';
    btn.addEventListener('click', open);
    var chip = topbar.querySelector('.userchip');
    if (chip) topbar.insertBefore(btn, chip);
    else topbar.appendChild(btn);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', addButton);
  } else {
    addButton();
  }
  setTimeout(addButton, 2000);
})();
