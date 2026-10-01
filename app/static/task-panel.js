/* openmuse P1 — 后台任务面板（Worker C）。
 * 自包含 classic script：不依赖 index.html 内部函数，自己带样式（tk- 前缀），
 * 只复用 :root 的深色主题变量。coordinator 负责：
 *   1) 在 index.html 引入 <script src="/task-panel.js"></script>
 *   2) 在 doSend 里接线 window.openmuseTasks（见 TASK_INTEGRATION.md）
 */
'use strict';
(function () {
  // ---------- 小工具 ----------
  function tkEsc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function $(sel, root) { return (root || document).querySelector(sel); }
  function fmtTime(s) {
    if (!s) return '—';
    try {
      return new Date(s).toLocaleString('zh-CN', { hour12: false });
    } catch (_) { return String(s); }
  }
  var STATUS_LABEL = { active: '待运行', running: '运行中', done: '已完成', failed: '失败' };

  // ---------- 样式（自带，不依赖 index.html 的 class） ----------
  var CSS = [
    '.tk-topbtn{border:1px solid var(--border);background:var(--panel);color:var(--muted);border-radius:9px;',
    'padding:6px 12px;font-size:13px;cursor:pointer;flex-shrink:0;transition:.15s}',
    '.tk-topbtn:hover{color:var(--text);border-color:var(--accent)}',
    '.tk-panel{position:fixed;top:0;right:0;bottom:0;width:400px;max-width:94vw;z-index:50;',
    'background:var(--bg2);border-left:1px solid var(--border);display:flex;flex-direction:column;',
    'transform:translateX(105%);transition:transform .25s ease;box-shadow:-20px 0 50px rgba(0,0,0,.5)}',
    '.tk-panel.open{transform:none}',
    '.tk-head{display:flex;align-items:center;justify-content:space-between;padding:14px 16px;border-bottom:1px solid var(--border)}',
    '.tk-head h2{font-size:15px;font-weight:700}',
    '.tk-close{border:1px solid var(--border);background:var(--panel);color:var(--muted);border-radius:8px;',
    'width:30px;height:30px;font-size:15px;cursor:pointer}',
    '.tk-close:hover{color:var(--text);border-color:var(--accent)}',
    '.tk-body{flex:1;overflow-y:auto;padding:14px 16px}',
    '.tk-sec{font-size:12.5px;color:var(--muted);letter-spacing:1px;margin:14px 0 8px}',
    '.tk-form{background:var(--panel);border:1px solid var(--border);border-radius:12px;padding:12px}',
    '.tk-form input[type=text],.tk-form textarea{width:100%;background:var(--bg);border:1px solid var(--border);',
    'border-radius:8px;color:var(--text);font-family:var(--font);font-size:13.5px;padding:8px 10px;outline:none}',
    '.tk-form input[type=text]:focus,.tk-form textarea:focus{border-color:var(--accent)}',
    '.tk-form textarea{min-height:70px;resize:vertical;margin-top:8px}',
    '.tk-row{display:flex;align-items:center;gap:14px;margin-top:10px;font-size:13.5px;color:var(--muted)}',
    '.tk-row label{display:flex;align-items:center;gap:6px;cursor:pointer}',
    '.tk-row input[type=radio]{accent-color:var(--accent)}',
    '.tk-cronzone{margin-top:10px;display:none}',
    '.tk-presets{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:8px}',
    '.tk-preset{border:1px solid var(--border);background:var(--bg);color:var(--muted);border-radius:16px;',
    'padding:5px 12px;font-size:12.5px;cursor:pointer;font-family:var(--mono)}',
    '.tk-preset:hover{color:var(--text);border-color:var(--accent)}',
    '.tk-preset.on{color:#fff;background:var(--accent);border-color:var(--accent)}',
    '.tk-cronhint{font-size:12px;color:var(--muted2);margin-top:6px;font-family:var(--mono)}',
    '.tk-cronhint.ok{color:#3ddc84}.tk-cronhint.bad{color:var(--danger)}',
    '.tk-create{width:100%;margin-top:12px;padding:10px;border:none;border-radius:10px;cursor:pointer;',
    'background:linear-gradient(135deg,var(--accent),#5a8df0);color:#fff;font-size:14px;transition:.15s}',
    '.tk-create:hover:not(:disabled){transform:translateY(-1px)}',
    '.tk-create:disabled{opacity:.5;cursor:default}',
    '.tk-item{background:var(--panel);border:1px solid var(--border);border-radius:12px;padding:10px 12px;margin-bottom:10px}',
    '.tk-item .nm{font-size:13.5px;font-weight:600;word-break:break-word}',
    '.tk-item .meta{font-size:12px;color:var(--muted2);margin-top:4px;font-family:var(--mono);word-break:break-all}',
    '.tk-badge{display:inline-block;font-size:11.5px;border-radius:10px;padding:2px 9px;margin-top:6px}',
    '.tk-badge.active{background:rgba(124,108,246,.15);color:#b7aefc}',
    '.tk-badge.running{background:rgba(245,185,66,.15);color:#f5b942;animation:tkblink 1.1s infinite}',
    '.tk-badge.done{background:rgba(61,220,132,.13);color:#3ddc84}',
    '.tk-badge.failed{background:rgba(242,109,109,.13);color:#f28b8b}',
    '@keyframes tkblink{0%,100%{opacity:1}50%{opacity:.45}}',
    '.tk-actions{display:flex;gap:8px;margin-top:8px}',
    '.tk-btn{border:1px solid var(--border);background:var(--bg);color:var(--muted);border-radius:8px;',
    'padding:5px 12px;font-size:12.5px;cursor:pointer}',
    '.tk-btn:hover{color:var(--text);border-color:var(--accent)}',
    '.tk-btn.danger:hover{color:#f28b8b;border-color:var(--danger)}',
    '.tk-empty{font-size:13px;color:var(--muted2);text-align:center;padding:24px 0}',
    '.tk-modal{position:fixed;inset:0;z-index:60;background:rgba(0,0,0,.6);display:none;align-items:center;justify-content:center}',
    '.tk-modal.open{display:flex}',
    '.tk-dialog{width:640px;max-width:92vw;max-height:80vh;display:flex;flex-direction:column;',
    'background:var(--panel);border:1px solid var(--border);border-radius:14px;overflow:hidden}',
    '.tk-dialog .dh{display:flex;align-items:center;justify-content:space-between;padding:12px 16px;border-bottom:1px solid var(--border)}',
    '.tk-dialog .dh b{font-size:14px}',
    '.tk-dialog pre{flex:1;overflow:auto;padding:14px 16px;margin:0;font-family:var(--mono);font-size:12.5px;',
    'color:#c9d2e3;white-space:pre-wrap;word-break:break-all}',
    '.tk-bgrow{display:flex;align-items:center;gap:7px;font-size:12.5px;color:var(--muted);margin:0 2px 8px;cursor:pointer;user-select:none}',
    '.tk-bgrow input{accent-color:var(--accent)}',
    '.tk-sysmsg{border:1px solid rgba(124,108,246,.35);background:rgba(124,108,246,.08);border-radius:12px;',
    'padding:10px 16px;margin-bottom:22px;font-size:13.5px;color:var(--text)}',
  ].join('\n');

  function injectCss() {
    var st = document.createElement('style');
    st.textContent = CSS;
    document.head.appendChild(st);
  }

  // ---------- DOM 注入 ----------
  var bgCheck = null; // composer 里的「后台运行」checkbox

  function injectTopbarBtn() {
    var topbar = $('.topbar');
    if (!topbar || $('#tkTopBtn')) return;
    var btn = document.createElement('button');
    btn.id = 'tkTopBtn';
    btn.className = 'tk-topbtn';
    btn.textContent = '⏱ 任务';
    btn.title = '后台任务与定时';
    btn.addEventListener('click', function () { panelEl.classList.toggle('open'); if (panelEl.classList.contains('open')) refreshList(); });
    var chip = $('#userChip');
    if (chip) topbar.insertBefore(btn, chip);
    else topbar.appendChild(btn);
  }

  var panelEl = null;
  function injectPanel() {
    if ($('#tkPanel')) { panelEl = $('#tkPanel'); return; }
    var aside = document.createElement('aside');
    aside.id = 'tkPanel';
    aside.className = 'tk-panel';
    aside.innerHTML =
      '<div class="tk-head"><h2>⏱ 后台任务</h2><button class="tk-close" id="tkClose">✕</button></div>' +
      '<div class="tk-body">' +
      '  <div class="tk-sec">新建任务</div>' +
      '  <div class="tk-form">' +
      '    <input type="text" id="tkName" placeholder="任务名称，例如：每天早上抓取 AI 新闻" maxlength="80">' +
      '    <textarea id="tkPrompt" placeholder="任务内容：Agent 在后台执行的具体指令…"></textarea>' +
      '    <div class="tk-row">' +
      '      <label><input type="radio" name="tkKind" value="once" checked> 执行一次</label>' +
      '      <label><input type="radio" name="tkKind" value="cron"> 定时重复</label>' +
      '    </div>' +
      '    <div class="tk-cronzone" id="tkCronZone">' +
      '      <div class="tk-presets">' +
      '        <button class="tk-preset" data-expr="0 * * * *">每小时</button>' +
      '        <button class="tk-preset" data-expr="0 9 * * *">每天 9:00</button>' +
      '        <button class="tk-preset" data-expr="0 9 * * 1">每周一 9:00</button>' +
      '      </div>' +
      '      <input type="text" id="tkCron" placeholder="自定义 cron：分 时 日 月 周，如 30 8 * * *" spellcheck="false">' +
      '      <div class="tk-cronhint" id="tkCronHint">5 个字段：分(0-59) 时(0-23) 日(1-31) 月(1-12) 周(0-6)</div>' +
      '    </div>' +
      '    <button class="tk-create" id="tkCreate">创建任务</button>' +
      '  </div>' +
      '  <div class="tk-sec">任务列表 <span style="float:right;cursor:pointer" id="tkRefresh" title="刷新">↻</span></div>' +
      '  <div id="tkList"><div class="tk-empty">加载中…</div></div>' +
      '</div>';
    ($('.app') || document.body).appendChild(aside);
    panelEl = aside;

    $('#tkClose').addEventListener('click', function () { panelEl.classList.remove('open'); });
    $('#tkRefresh').addEventListener('click', refreshList);

    // 类型切换
    var radios = aside.querySelectorAll('input[name=tkKind]');
    for (var i = 0; i < radios.length; i++) {
      radios[i].addEventListener('change', function () {
        $('#tkCronZone').style.display = getKind() === 'cron' ? 'block' : 'none';
      });
    }
    // 预设
    var presets = aside.querySelectorAll('.tk-preset');
    for (var j = 0; j < presets.length; j++) {
      presets[j].addEventListener('click', function () {
        var expr = this.getAttribute('data-expr');
        $('#tkCron').value = expr;
        for (var k = 0; k < presets.length; k++) presets[k].classList.remove('on');
        this.classList.add('on');
        checkCron(expr);
      });
    }
    // 自定义表达式：简单正则预校验（不阻塞提交，服务端会再校验）
    $('#tkCron').addEventListener('input', function () { checkCron(this.value); });
    $('#tkCreate').addEventListener('click', createTask);
  }

  // 简单正则预校验：5 个字段即可；不阻塞提交
  function checkCron(v) {
    var hint = $('#tkCronHint');
    if (!hint) return;
    v = (v || '').trim();
    if (!v) { hint.className = 'tk-cronhint'; hint.textContent = '5 个字段：分(0-59) 时(0-23) 日(1-31) 月(1-12) 周(0-6)'; return; }
    var ok = /^\S+\s+\S+\s+\S+\s+\S+\s+\S+$/.test(v);
    hint.className = 'tk-cronhint ' + (ok ? 'ok' : 'bad');
    hint.textContent = ok ? '✓ 格式看起来没问题（服务端会再校验）' : '✗ 需要 5 个字段，用空格分隔';
  }

  function getKind() {
    var r = document.querySelector('input[name=tkKind]:checked');
    return r ? r.value : 'once';
  }

  // ---------- composer 注入「后台运行」 ----------
  function injectComposerCheck() {
    var box = $('.composer .box');
    if (!box || $('#tkBgCheck')) return;
    var bar = $('.bar', box);
    var label = document.createElement('label');
    label.className = 'tk-bgrow';
    label.innerHTML = '<input type="checkbox" id="tkBgCheck"> 后台运行（不阻塞聊天，完成后在任务面板查看结果）';
    if (bar) box.insertBefore(label, bar);
    else box.appendChild(label);
    bgCheck = $('#tkBgCheck');
  }

  // ---------- API ----------
  async function api(path, opts) {
    var res = await fetch(path, opts);
    if (res.status === 401) throw new Error('请先登录');
    if (res.status === 503) {
      var d503 = await res.json().catch(function () { return {}; });
      throw new Error(d503.message || '服务端任务功能暂不可用（503）');
    }
    var data = await res.json().catch(function () { return null; });
    if (!res.ok) throw new Error((data && data.message) || ('请求失败（' + res.status + '）'));
    return data;
  }

  async function createTask() {
    var name = $('#tkName').value.trim();
    var prompt = $('#tkPrompt').value.trim();
    var kind = getKind();
    var cronExpr = $('#tkCron').value.trim();
    if (!name) { alert('请填写任务名称'); return; }
    if (!prompt) { alert('请填写任务内容'); return; }
    var btn = $('#tkCreate');
    btn.disabled = true;
    try {
      await api('/api/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name, prompt: prompt, kind: kind, cron_expr: cronExpr || undefined }),
      });
      $('#tkName').value = '';
      $('#tkPrompt').value = '';
      $('#tkCron').value = '';
      checkCron('');
      refreshList();
    } catch (e) {
      alert('创建失败：' + e.message);
    }
    btn.disabled = false;
  }

  async function refreshList() {
    var list = $('#tkList');
    if (!list) return;
    try {
      var tasks = await api('/api/tasks');
      if (!tasks.length) {
        list.innerHTML = '<div class="tk-empty">还没有任务。在上方创建一个，或在输入框勾选「后台运行」发送。</div>';
        return;
      }
      list.innerHTML = tasks.map(renderItem).join('');
      // 绑定按钮
      var items = list.querySelectorAll('.tk-item');
      for (var i = 0; i < items.length; i++) {
        (function (el) {
          var id = el.getAttribute('data-id');
          var t = tasks.filter(function (x) { return String(x.id) === id; })[0];
          $('.tk-view', el).addEventListener('click', function () { showResult(t); });
          $('.tk-run', el).addEventListener('click', function () { runNow(id); });
          $('.tk-del', el).addEventListener('click', function () { delTask(id, t && t.name); });
        })(items[i]);
      }
    } catch (e) {
      list.innerHTML = '<div class="tk-empty">' + tkEsc(e.message) + '</div>';
    }
  }

  function renderItem(t) {
    var kindLabel = t.kind === 'cron' ? '定时 <span>' + tkEsc(t.cron_expr || '') + '</span>' : '执行一次';
    var st = STATUS_LABEL[t.status] || t.status;
    return '<div class="tk-item" data-id="' + tkEsc(t.id) + '">' +
      '<div class="nm">' + tkEsc(t.name) + '</div>' +
      '<div class="meta">' + kindLabel + ' · 下次运行 ' + tkEsc(fmtTime(t.next_run_at)) + '</div>' +
      '<span class="tk-badge ' + tkEsc(t.status) + '">' + tkEsc(st) + '</span>' +
      '<div class="tk-actions">' +
      '<button class="tk-btn tk-view">查看结果</button>' +
      '<button class="tk-btn tk-run">立即运行</button>' +
      '<button class="tk-btn danger tk-del">删除</button>' +
      '</div></div>';
  }

  async function runNow(id) {
    try {
      await api('/api/tasks/' + encodeURIComponent(id) + '/run', { method: 'POST' });
      refreshList();
    } catch (e) { alert('触发失败：' + e.message); }
  }

  async function delTask(id, name) {
    if (!confirm('确定删除任务「' + (name || id) + '」吗？')) return;
    try {
      await api('/api/tasks/' + encodeURIComponent(id), { method: 'DELETE' });
      refreshList();
    } catch (e) { alert('删除失败：' + e.message); }
  }

  // ---------- 结果弹窗 ----------
  var modalEl = null;
  function showResult(t) {
    if (!modalEl) {
      modalEl = document.createElement('div');
      modalEl.className = 'tk-modal';
      modalEl.innerHTML =
        '<div class="tk-dialog"><div class="dh"><b id="tkDhTitle">任务结果</b>' +
        '<button class="tk-close" id="tkDhClose">✕</button></div><pre id="tkDhBody"></pre></div>';
      document.body.appendChild(modalEl);
      $('#tkDhClose').addEventListener('click', function () { modalEl.classList.remove('open'); });
      modalEl.addEventListener('click', function (e) { if (e.target === modalEl) modalEl.classList.remove('open'); });
    }
    $('#tkDhTitle').textContent = '任务结果 · ' + (t.name || t.id);
    var body = $('#tkDhBody');
    var meta = '状态：' + (STATUS_LABEL[t.status] || t.status) +
      '\n上次运行：' + fmtTime(t.last_run_at) +
      '\n下次运行：' + fmtTime(t.next_run_at) + '\n\n';
    body.textContent = meta + (t.result ? t.result : '(暂无结果，任务尚未执行或执行中)');
    modalEl.classList.add('open');
  }

  // ---------- 对外 API（coordinator 在 doSend 里接线） ----------
  function sysMsg(html) {
    var inner = $('#inner');
    if (!inner) return;
    var d = document.createElement('div');
    d.innerHTML = '<div class="tk-sysmsg">' + html + '</div>';
    inner.appendChild(d.firstChild);
    var msgs = $('#msgs');
    if (msgs) msgs.scrollTop = msgs.scrollHeight;
  }

  window.openmuseTasks = {
    // doSend 发送前调用：勾选了「后台运行」则走后台任务
    isBackground: function () { return !!(bgCheck && bgCheck.checked); },
    // 提交后台任务：POST /api/chat {message, background:true} → {task_id}
    submitBackground: async function (text) {
      try {
        var data = await api('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: text, background: true }),
        });
        var tid = String((data && data.task_id) || '');
        sysMsg('⏱ 已创建后台任务（<code>' + tkEsc(tid.slice(0, 8)) + '</code>），完成后可在任务面板查看结果。');
        if (bgCheck) bgCheck.checked = false;
        if (panelEl && panelEl.classList.contains('open')) refreshList();
        return tid;
      } catch (e) {
        sysMsg('⚠ 后台任务创建失败：' + tkEsc(e.message));
        return null;
      }
    },
    refresh: refreshList,
  };

  // ---------- 启动 ----------
  function boot() {
    injectCss();
    injectTopbarBtn();
    injectPanel();
    injectComposerCheck();
    // 面板打开时每 15s 刷新一次状态
    setInterval(function () {
      if (panelEl && panelEl.classList.contains('open')) refreshList();
    }, 15000);
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
