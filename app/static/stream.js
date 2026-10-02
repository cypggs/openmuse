/* openmuse Live View — H264 推流（对标 Memoh）。
 * 顶栏"浏览器"按钮 → GET /api/stream/url → WebSocket → JMuxer (MSE) → <video>。
 * 输入：鼠标/键盘 → JSON → WS → sandbox RFB。
 */
(function () {
  'use strict';

  var modal = null;
  var video = null;
  var jmuxer = null;
  var ws = null;
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

    if (connected && video) {
      body.innerHTML = '';
      body.appendChild(video);
      return;
    }

    body.innerHTML = '<div class="lv-loading">正在连接云电脑…</div>';

    try {
      var r = await fetch('/api/stream/url', { credentials: 'same-origin' });
      if (!r.ok) throw new Error('获取推流地址失败 (' + r.status + ')');
      var data = await r.json();
      var wsUrl = data.url;
      console.log('[liveview] stream url:', wsUrl);

      // video 元素
      video = document.createElement('video');
      video.style.cssText = 'width:100%;height:100%;object-fit:contain;background:#000;cursor:crosshair;';
      video.muted = true;
      video.playsInline = true;
      body.innerHTML = '';
      body.appendChild(video);

      // JMuxer (MSE)
      if (typeof JMuxer === 'undefined') throw new Error('JMuxer 未加载');
      jmuxer = new JMuxer({
        node: video,
        mode: 'video',
        flushingTime: 100,
        maxDelay: 1000,
        debug: false,
        onError: function (e) { console.error('[liveview] jmuxer error:', e); }
      });

      // WebSocket 收 H264
      ws = new WebSocket(wsUrl);
      ws.binaryType = 'arraybuffer';
      ws.onopen = function () {
        console.log('[liveview] ws connected');
        connected = true;
      };
      ws.onmessage = function (ev) {
        // 直接喂给 JMuxer（Annex B H264）
        jmuxer.feed({ video: new Uint8Array(ev.data) });
      };
      ws.onerror = function () { showError('WebSocket 连接失败'); connected = false; };
      ws.onclose = function () {
        console.log('[liveview] ws closed');
        connected = false;
        if (jmuxer) { try { jmuxer.destroy(); } catch (_) {} jmuxer = null; }
      };

      video.play().catch(function () {});

      bindInput(video);

    } catch (e) {
      console.error('[liveview]', e);
      showError(e.message);
    }
  }

  function close() {
    modal.classList.remove('open');
  }

  // ---- 输入 ----
  function keysymForEvent(e) {
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
  function videoPos(e) {
    var r = video.getBoundingClientRect();
    var x = Math.round((e.clientX - r.left) / r.width * 1280);
    var y = Math.round((e.clientY - r.top) / r.height * 800);
    return { x: Math.max(0, Math.min(1279, x)), y: Math.max(0, Math.min(799, y)) };
  }
  function bindInput(v) {
    var buttons = 0;
    v.oncontextmenu = function (e) { e.preventDefault(); };
    v.addEventListener('mousedown', function (e) {
      var p = videoPos(e);
      buttons = e.button === 0 ? 1 : e.button === 2 ? 4 : 2;
      sendInput({ type: 'pointer', x: p.x, y: p.y, buttonMask: buttons });
    });
    v.addEventListener('mouseup', function (e) {
      var p = videoPos(e);
      buttons = 0;
      sendInput({ type: 'pointer', x: p.x, y: p.y, buttonMask: 0 });
    });
    v.addEventListener('mousemove', function (e) {
      if (!buttons) return;
      var p = videoPos(e);
      sendInput({ type: 'pointer', x: p.x, y: p.y, buttonMask: buttons });
    });
    v.tabIndex = 0;
    v.addEventListener('keydown', function (e) {
      var ks = keysymForEvent(e);
      if (ks) { sendInput({ type: 'key', keysym: ks, down: true }); e.preventDefault(); }
    });
    v.addEventListener('keyup', function (e) {
      var ks = keysymForEvent(e);
      if (ks) { sendInput({ type: 'key', keysym: ks, down: false }); e.preventDefault(); }
    });
  }

  window.__openmuseLiveView = open;

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
