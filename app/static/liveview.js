/* openmuse P2 — Live View（noVNC 嵌入）。
 * 顶栏"浏览器"按钮 → 获取 /api/browser/live-url → 弹窗 iframe。
 * noVNC 原生可交互，用户可随时接管操作。
 */
(function () {
  'use strict';

  var modal = null;
  var iframe = null;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
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
      '<span class="lv-hint">可直接操作（点击/输入），与 agent 共享同一台电脑</span>' +
      '<button class="lv-close" title="关闭">✕</button>' +
      '</div>' +
      '<div class="lv-body"><div class="lv-loading">正在连接云电脑…</div></div>' +
      '</div>';
    document.body.appendChild(modal);
    modal.querySelector('.lv-close').addEventListener('click', close);
    modal.querySelector('.lv-backdrop').addEventListener('click', close);
    // Esc 关闭
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && modal.classList.contains('open')) close();
    });
    iframe = null;
    return modal;
  }

  async function open() {
    ensureModal();
    modal.classList.add('open');
    var body = modal.querySelector('.lv-body');
    // 如果已有 iframe（之前打开过），直接显示（保持连接）
    if (iframe) {
      body.innerHTML = '';
      body.appendChild(iframe);
      return;
    }
    body.innerHTML = '<div class="lv-loading">正在连接云电脑…</div>';
    try {
      var r = await fetch('/api/browser/live-url');
      var j = await r.json();
      if (!r.ok) throw new Error(j.message || '获取失败');
      iframe = document.createElement('iframe');
      iframe.src = j.url;
      iframe.className = 'lv-iframe';
      iframe.setAttribute('allow', 'clipboard-read; clipboard-write');
      body.innerHTML = '';
      body.appendChild(iframe);
    } catch (e) {
      body.innerHTML = '<div class="lv-error">连接失败：' + esc(e.message) + '<br>请确认云电脑已启动（发一条消息试试）。</div>';
    }
  }

  function close() {
    if (modal) modal.classList.remove('open');
    // 不销毁 iframe，保持 noVNC 连接（下次打开更快）
  }

  // 对外接口（审批卡片的"亲自登录"按钮用）
  window.openLiveView = open;

  // 顶栏按钮（等 DOM 就绪后插入）
  function addButton() {
    var topbar = document.querySelector('.topbar');
    if (!topbar || document.getElementById('liveviewBtn')) return;
    var btn = document.createElement('button');
    btn.id = 'liveviewBtn';
    btn.className = 'lv-btn';
    btn.title = '打开云电脑实时画面（可观看/接管浏览器）';
    btn.textContent = '🖥️ 浏览器';
    btn.addEventListener('click', open);
    // 插到 userchip 前面
    var chip = topbar.querySelector('.userchip');
    if (chip) topbar.insertBefore(btn, chip);
    else topbar.appendChild(btn);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', addButton);
  } else {
    addButton();
  }
  // 兼容 SPA 式加载，延迟再试一次
  setTimeout(addButton, 2000);
})();
