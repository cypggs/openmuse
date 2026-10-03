/* openmuse 工作区 — 对话/终端/浏览器/桌面 标签页（对标 Memoh）。
 * 顶栏「💻 云电脑」按钮 → 下拉菜单 → 选择视图。
 * - 终端：xterm.js + WebSocket PTY
 * - 浏览器/桌面：H264 推流（复用 stream.js 的 Live View）
 */
(function () {
  'use strict';

  var menu = null;
  var termModal = null;
  var termInited = false;

  function ensureMenu() {
    if (menu) return menu;
    menu = document.createElement('div');
    menu.id = 'workspaceMenu';
    menu.className = 'ws-menu';
    menu.innerHTML =
      '<div class="ws-item" data-view="terminal"><span class="ws-icon">>_</span> 终端</div>' +
      '<div class="ws-item" data-view="browser"><span class="ws-icon">🌐</span> 浏览器</div>' +
      '<div class="ws-item" data-view="desktop"><span class="ws-icon">🖥️</span> 桌面</div>';
    document.body.appendChild(menu);

    menu.addEventListener('click', function (e) {
      var item = e.target.closest('.ws-item');
      if (!item) return;
      hideMenu();
      openView(item.dataset.view);
    });

    // 点击外部关闭
    document.addEventListener('click', function (e) {
      if (menu.classList.contains('open') &&
          !e.target.closest('#workspaceBtn') &&
          !e.target.closest('#workspaceMenu')) {
        hideMenu();
      }
    });

    return menu;
  }

  function showMenu(btn) {
    ensureMenu();
    var r = btn.getBoundingClientRect();
    menu.style.top = (r.bottom + 8) + 'px';
    menu.style.left = r.left + 'px';
    menu.classList.add('open');
  }

  function hideMenu() {
    if (menu) menu.classList.remove('open');
  }

  function openView(view) {
    if (view === 'terminal') {
      openTerminal();
    } else if (view === 'browser' || view === 'desktop') {
      // 复用 stream.js 的 Live View（H264 推流，桌面+浏览器同一画面）
      if (window.__openmuseLiveView) {
        window.__openmuseLiveView();
      }
    }
  }

  // ---- 终端弹窗 ----
  function ensureTermModal() {
    if (termModal) return termModal;
    termModal = document.createElement('div');
    termModal.id = 'terminalModal';
    termModal.innerHTML =
      '<div class="lv-backdrop"></div>' +
      '<div class="lv-panel">' +
      '<div class="lv-head">' +
      '<span class="lv-title">>_ 云电脑 · 终端</span>' +
      '<span class="lv-hint">与 agent 共享同一台电脑</span>' +
      '<button class="lv-close" title="关闭">✕</button>' +
      '</div>' +
      '<div class="lv-body" id="termBody" style="background:#1a1b26;padding:8px;"></div>' +
      '</div>';
    document.body.appendChild(termModal);
    termModal.querySelector('.lv-close').addEventListener('click', function () {
      termModal.classList.remove('open');
    });
    termModal.querySelector('.lv-backdrop').addEventListener('click', function () {
      termModal.classList.remove('open');
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && termModal.classList.contains('open')) {
        termModal.classList.remove('open');
      }
    });
    return termModal;
  }

  function openTerminal() {
    ensureTermModal();
    termModal.classList.add('open');
    if (!termInited && window.__openmuseTerminal) {
      var body = document.getElementById('termBody');
      // 设置终端容器高度
      body.style.height = '500px';
      window.__openmuseTerminal.init(body);
      termInited = true;
    }
  }

  // ---- 顶栏按钮 ----
  function addButton() {
    var topbar = document.querySelector('.topbar');
    if (!topbar || document.getElementById('workspaceBtn')) return;

    // 移除旧的 liveviewBtn（如果存在，stream.js 会创建）
    var oldBtn = document.getElementById('liveviewBtn');
    if (oldBtn) oldBtn.remove();

    var btn = document.createElement('button');
    btn.id = 'workspaceBtn';
    btn.className = 'lv-btn';
    btn.title = '云电脑：终端 / 浏览器 / 桌面';
    btn.textContent = '💻 云电脑';
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      if (menu && menu.classList.contains('open')) hideMenu();
      else showMenu(btn);
    });

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

  // 对外
  window.__openmuseWorkspace = { openView: openView };
})();
