/* openmuse 终端 — xterm.js + WebSocket PTY（对标 Memoh）。
 * 连接 /api/terminal/url 返回的 wss 地址。
 */
(function () {
  'use strict';

  var term = null;
  var ws = null;
  var container = null;

  // 测量单个字符的像素尺寸（用于 fit 计算）
  function measureChar() {
    var probe = document.createElement('span');
    probe.style.cssText =
      'position:absolute;visibility:hidden;top:0;left:0;' +
      'font-family:Menlo, Monaco, "Courier New", monospace;font-size:14px;' +
      'white-space:pre;';
    probe.textContent = 'MMMMMMMMMM';
    document.body.appendChild(probe);
    var w = probe.offsetWidth / 10;
    var h = probe.offsetHeight || 17;
    document.body.removeChild(probe);
    return { w: w || 8.4, h: h };
  }

  // 让 xterm 填满容器，并把新尺寸发给后端 PTY
  function fit() {
    if (!term || !container) return;
    var cw = container.clientWidth;
    var ch = container.clientHeight;
    if (!cw || !ch) return;
    var d = measureChar();
    var cols = Math.max(40, Math.floor(cw / d.w));
    var rows = Math.max(10, Math.floor(ch / d.h));
    if (cols !== term.cols || rows !== term.rows) {
      term.resize(cols, rows);
      if (ws && ws.readyState === 1) {
        try {
          ws.send(JSON.stringify({ type: 'resize', cols: cols, rows: rows }));
        } catch (_) {}
      }
    }
  }

  function initTerminal(el) {
    if (term) return term;
    container = el;

    if (typeof Terminal === 'undefined') {
      el.innerHTML = '<div style="color:#f66;padding:20px">xterm.js 未加载</div>';
      return null;
    }

    term = new Terminal({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      theme: {
        background: '#1a1b26',
        foreground: '#c0caf5',
        cursor: '#c0caf5',
        selection: 'rgba(122,162,247,0.3)',
      },
      cols: 80,
      rows: 24,
    });
    term.open(el);
    term.writeln('\x1b[1;36m正在连接云电脑终端…\x1b[0m');

    // 自适应容器大小：去掉 80x24 固定尺寸，按实际像素算 cols/rows
    fit();
    // 窗口变化时重算
    if (!fit._bound) {
      fit._bound = true;
      window.addEventListener('resize', function () {
        if (container && container.offsetParent !== null) fit();
      });
    }

    connect();

    term.onData(function (data) {
      if (ws && ws.readyState === 1) {
        ws.send(data);
      }
    });

    return term;
  }

  async function connect() {
    try {
      var r = await fetch('/api/terminal/url', { credentials: 'same-origin' });
      if (!r.ok) throw new Error('获取终端地址失败 (' + r.status + ')');
      var data = await r.json();
      console.log('[terminal] url:', data.url);

      ws = new WebSocket(data.url);
      ws.binaryType = 'arraybuffer';

      ws.onopen = function () {
        console.log('[terminal] connected');
        term.writeln('\x1b[1;32m✓ 已连接\x1b[0m');
      };
      ws.onmessage = function (ev) {
        var data;
        if (typeof ev.data === 'string') {
          data = ev.data;
        } else {
          data = new Uint8Array(ev.data);
        }
        term.write(data);
      };
      ws.onerror = function () {
        term.writeln('\r\n\x1b[1;31m连接失败\x1b[0m');
      };
      ws.onclose = function () {
        console.log('[terminal] closed');
        term.writeln('\r\n\x1b[33m连接断开，点击重连\x1b[0m');
      };
    } catch (e) {
      console.error('[terminal]', e);
      term.writeln('\r\n\x1b[1;31m' + e.message + '\x1b[0m');
    }
  }

  function reconnect() {
    if (ws) { try { ws.close(); } catch (_) {} }
    if (term) term.clear();
    connect();
  }

  // 对外 API
  window.__openmuseTerminal = {
    init: initTerminal,
    reconnect: reconnect,
    refit: fit,
    get term() { return term; },
  };
})();
