/* openmuse P0 — 审批卡片（前端）。
 * 连接 /api/events SSE，收到审批请求时弹出卡片；
 * 用户点 允许一次 / 始终允许 / 拒绝 → POST /api/approvals/:id/decide。
 */
(function () {
  'use strict';

  var container = null;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function ensureContainer() {
    if (container) return container;
    container = document.createElement('div');
    container.id = 'approvalStack';
    document.body.appendChild(container);
    return container;
  }

  // 倒计时显示
  function fmtLeft(ms) {
    if (ms <= 0) return '已过期';
    var s = Math.floor(ms / 1000);
    var m = Math.floor(s / 60);
    s = s % 60;
    return m + '分' + (s < 10 ? '0' : '') + s + '秒';
  }

  function detailLines(detail) {
    var d = detail || {};
    var lines = [];
    if (d.site) lines.push(['站点', d.site]);
    if (d.domain) lines.push(['域名', d.domain]);
    if (d.username) lines.push(['账号', d.username]);
    if (d.action) lines.push(['操作', d.action]);
    if (d.url) lines.push(['页面', d.url]);
    if (d.reason) lines.push(['说明', d.reason]);
    return lines;
  }

  function renderCard(a) {
    ensureContainer();
    var old = document.getElementById('appr-' + a.id);
    if (old) old.remove();

    var card = document.createElement('div');
    card.className = 'appr-card';
    card.id = 'appr-' + a.id;

    var lines = detailLines(a.detail)
      .map(function (kv) {
        return '<div class="appr-row"><span class="k">' + esc(kv[0]) + '</span><span class="v">' + esc(kv[1]) + '</span></div>';
      })
      .join('');

    // 凭证/登录类审批：提供"亲自登录"选项（打开 Live View，用户自己输密码）
    var isLoginKind = a.kind === 'credential_fill' || a.kind === 'sensitive_nav';
    var loginBtn = isLoginKind
      ? '<button class="appr-btn login" data-act="open-live">🖥️ 亲自登录</button>'
      : '';

    card.innerHTML =
      '<div class="appr-head"><span class="appr-icon">🔐</span>' +
      '<div class="appr-titles"><div class="appr-title">' + esc(a.title) + '</div>' +
      '<div class="appr-kind">' + esc(kindLabel(a.kind)) + ' · <span class="appr-timer" data-exp="' + esc(a.expires_at) + '"></span></div></div></div>' +
      '<div class="appr-detail">' + lines + '</div>' +
      '<div class="appr-note">任务已暂停，等待你的决定。凭证值不会显示在这里。</div>' +
      '<div class="appr-btns">' +
      '<button class="appr-btn allow" data-d="allow_once">允许一次</button>' +
      '<button class="appr-btn always" data-d="allow_always">始终允许</button>' +
      '<button class="appr-btn deny" data-d="deny">拒绝</button>' +
      '</div>' + (loginBtn ? '<div class="appr-btns appr-btns2">' + loginBtn + '</div>' : '');

    card.querySelectorAll('.appr-btn[data-d]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        decide(a.id, btn.getAttribute('data-d'), card);
      });
    });
    var loginEl = card.querySelector('.appr-btn[data-act="open-live"]');
    if (loginEl) {
      loginEl.addEventListener('click', function () {
        // 打开 Live View 让用户亲自登录；审批保持 pending（用户登完后可点允许/拒绝）
        if (window.openLiveView) window.openLiveView();
        var note = card.querySelector('.appr-note');
        if (note) note.textContent = '已打开实时画面，请在浏览器里完成登录，回来后点"允许一次"继续。';
      });
    }

    container.appendChild(card);
    tickTimers();
    // 轻提示音效（可选，失败静默）
    try {
      var ctx = new (window.AudioContext || window.webkitAudioContext)();
      var o = ctx.createOscillator(), g = ctx.createGain();
      o.connect(g); g.connect(ctx.destination);
      o.frequency.value = 660; g.gain.value = 0.06;
      o.start(); g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.25);
      o.stop(ctx.currentTime + 0.3);
    } catch (_) {}
  }

  function kindLabel(kind) {
    var map = {
      credential_fill: '凭证填入',
      sensitive_nav: '敏感站点',
      download: '文件下载',
      form_submit: '表单提交',
      file_access: '文件访问',
    };
    return map[kind] || kind;
  }

  function tickTimers() {
    document.querySelectorAll('.appr-timer').forEach(function (el) {
      var exp = new Date(el.getAttribute('data-exp')).getTime();
      var left = exp - Date.now();
      el.textContent = '剩余 ' + fmtLeft(left);
      el.classList.toggle('urgent', left < 3 * 60 * 1000);
    });
  }
  setInterval(tickTimers, 1000);

  function removeCard(id, decision) {
    var card = document.getElementById('appr-' + id);
    if (!card) return;
    card.classList.add('decided-' + decision);
    var note = card.querySelector('.appr-note');
    if (note) {
      var label = {
        allow_once: '已允许（仅本次）',
        allow_always: '已允许（此后不再询问）',
        deny: '已拒绝',
        denied: '已拒绝',
        expired: '已过期',
      }[decision] || decision;
      note.textContent = label + '，任务继续。';
    }
    card.querySelectorAll('.appr-btn').forEach(function (b) { b.disabled = true; });
    setTimeout(function () {
      card.style.opacity = '0';
      card.style.transform = 'translateX(20px)';
      setTimeout(function () { card.remove(); }, 300);
    }, 2500);
  }

  async function decide(id, decision, card) {
    card.querySelectorAll('.appr-btn').forEach(function (b) { b.disabled = true; });
    try {
      var r = await fetch('/api/approvals/' + encodeURIComponent(id) + '/decide', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision: decision }),
      });
      var j = await r.json().catch(function () { return {}; });
      if (!r.ok) throw new Error(j.message || ('HTTP ' + r.status));
      removeCard(id, j.decision || decision);
    } catch (e) {
      card.querySelectorAll('.appr-btn').forEach(function (b) { b.disabled = false; });
      var note = card.querySelector('.appr-note');
      if (note) note.textContent = '提交失败：' + e.message + '，请重试。';
    }
  }

  function connectSSE() {
    var es;
    try {
      es = new EventSource('/api/events');
    } catch (_) {
      return;
    }
    es.onmessage = function (ev) {
      try {
        var msg = JSON.parse(ev.data);
        if (msg.t === 'approval' && msg.approval) {
          renderCard(msg.approval);
        } else if (msg.t === 'approval_decided' && msg.id) {
          removeCard(msg.id, msg.decision);
        }
      } catch (_) {}
    };
    es.onerror = function () {
      // EventSource 会自动重连；这里不做额外处理
    };
  }

  async function loadPending() {
    try {
      var r = await fetch('/api/approvals/pending');
      if (!r.ok) return;
      var j = await r.json();
      (j.approvals || []).forEach(renderCard);
    } catch (_) {}
  }

  // 启动
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () {
      connectSSE();
      loadPending();
    });
  } else {
    connectSSE();
    loadPending();
  }
})();
