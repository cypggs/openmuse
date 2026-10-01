/* openmuse P1 Worker B — Artifacts 画布前端面板。
 *
 * 自包含 classic script：不依赖 index.html 的任何函数，自带 escapeHtml 与
 * 极简 markdown 渲染。coordinator 只需在 index.html 中：
 *   <script src="/artifact-panel.js"></script>
 * 并在 doSend 的 SSE 分发里加：
 *   else if(o.t==='artifact'){window.dispatchEvent(new CustomEvent('openmuse:artifact',{detail:o}));}
 *
 * 安全红线：
 *   html 类型一律 <iframe sandbox="allow-scripts" srcdoc="...">，
 *   绝不加 allow-same-origin（opaque origin，防 XSS）。
 */
(function () {
  'use strict';

  /* ---------- 自带工具 ---------- */
  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // 极简 markdown：先整体转义再套行内语法，防注入
  function renderMiniMarkdown(src) {
    var text = escapeHtml(src);
    var lines = text.split('\n');
    var html = '';
    var inList = false;
    function inline(s) {
      s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
      s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
      s = s.replace(/\*([^*]+)\*/g, '<em>$1</em>');
      s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
      return s;
    }
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (/^#{1,4}\s/.test(line)) {
        if (inList) { html += '</ul>'; inList = false; }
        var m = line.match(/^(#{1,4})\s(.*)$/);
        var lvl = Math.min(m[1].length + 2, 4);
        html += '<h' + lvl + '>' + inline(m[2]) + '</h' + lvl + '>';
      } else if (/^[-*]\s+/.test(line)) {
        if (!inList) { html += '<ul>'; inList = true; }
        html += '<li>' + inline(line.replace(/^[-*]\s+/, '')) + '</li>';
      } else if (/^\s*$/.test(line)) {
        if (inList) { html += '</ul>'; inList = false; }
      } else {
        if (inList) { html += '</ul>'; inList = false; }
        html += '<p>' + inline(line) + '</p>';
      }
    }
    if (inList) html += '</ul>';
    return html;
  }

  function fmtTime(iso) {
    try {
      var d = new Date(iso);
      var p = function (n) { return (n < 10 ? '0' : '') + n; };
      return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' +
        p(d.getHours()) + ':' + p(d.getMinutes());
    } catch (e) { return ''; }
  }

  var TYPE_LABEL = { html: '网页', markdown: '文档', svg: '矢量图', code: '代码' };

  /* ---------- 样式（贴近现有深色主题） ---------- */
  var css = [
    '.canvas-toggle{border:1px solid var(--border);background:var(--panel);color:var(--muted);',
    'border-radius:9px;padding:7px 14px;font-size:13px;cursor:pointer;transition:.15s;margin-left:auto;}',
    '.canvas-toggle:hover{color:var(--text);border-color:var(--accent);}',
    '.canvas-toggle.on{color:var(--accent2);border-color:var(--accent2);}',
    '.canvas-panel{width:420px;flex-shrink:0;background:var(--bg2);border-left:1px solid var(--border);',
    'display:none;flex-direction:column;min-height:0;z-index:15;}',
    '.canvas-panel.open{display:flex;}',
    '.canvas-head{display:flex;align-items:center;gap:10px;padding:12px 16px;border-bottom:1px solid var(--border);}',
    '.canvas-head .ttl{font-size:14px;font-weight:700;flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
    '.canvas-head button{border:1px solid var(--border);background:var(--panel);color:var(--muted);',
    'border-radius:8px;padding:5px 10px;font-size:12px;cursor:pointer;}',
    '.canvas-head button:hover{color:var(--text);border-color:var(--accent);}',
    '.canvas-body{flex:1;overflow-y:auto;padding:14px 16px;}',
    '.canvas-item{display:flex;align-items:center;gap:10px;padding:10px 12px;border-radius:10px;cursor:pointer;',
    'font-size:13.5px;color:var(--muted);border:1px solid transparent;transition:.15s;}',
    '.canvas-item:hover,.canvas-item.active{background:var(--panel2);color:var(--text);border-color:var(--border);}',
    '.canvas-item .t{flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
    '.canvas-item .time{font-size:11px;color:var(--muted2);flex-shrink:0;}',
    '.atype{font-size:11px;padding:2px 8px;border-radius:20px;border:1px solid var(--border);flex-shrink:0;}',
    '.atype.html{color:var(--accent2);border-color:var(--accent2);}',
    '.atype.markdown{color:var(--accent);border-color:var(--accent);}',
    '.atype.svg{color:#3ddc84;border-color:#3ddc84;}',
    '.atype.code{color:#f2b26d;border-color:#f2b26d;}',
    '.canvas-item .adel{opacity:0;flex-shrink:0;width:24px;height:24px;border:none;border-radius:6px;',
    'background:transparent;color:var(--muted2);cursor:pointer;font-size:15px;line-height:1;}',
    '.canvas-item:hover .adel{opacity:1;}',
    '.canvas-item .adel:hover{color:var(--danger);}',
    '.canvas-view h3{font-size:16px;margin:0 0 10px;word-break:break-all;}',
    '.canvas-view .md h2,.canvas-view .md h3,.canvas-view .md h4{margin:14px 0 8px;}',
    '.canvas-view .md p{margin:0 0 10px;color:var(--text);word-break:break-word;}',
    '.canvas-view .md ul{margin:0 0 10px;padding-left:20px;}',
    '.canvas-view .md code{background:rgba(255,255,255,.07);padding:1px 6px;border-radius:5px;font-size:13px;}',
    '.canvas-view .md a{color:var(--accent2);}',
    '.canvas-view iframe{width:100%;height:calc(100vh - 240px);min-height:420px;border:1px solid var(--border);',
    'border-radius:12px;background:#fff;}',
    '.canvas-view .svgbox{border:1px solid var(--border);border-radius:12px;background:#fff;',
    'padding:12px;display:flex;justify-content:center;}',
    '.canvas-view .codebox{margin:0;border:1px solid var(--border);border-radius:12px;overflow:auto;',
    'background:#0a0d13;padding:14px;font-size:13px;line-height:1.7;white-space:pre-wrap;word-break:break-all;}',
    '.canvas-empty{color:var(--muted2);font-size:13px;padding:20px 4px;text-align:center;}',
    '.canvas-err{color:var(--danger);font-size:13px;padding:12px;}'
  ].join('\n');
  var style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);

  /* ---------- DOM：开关按钮 + 右侧面板 ---------- */
  var topbar = document.querySelector('.topbar');
  var app = document.querySelector('.app');
  if (!topbar || !app) return; // 结构不符则静默退出，不破坏现有页面

  var panel = document.createElement('aside');
  panel.className = 'canvas-panel';
  panel.innerHTML =
    '<div class="canvas-head">' +
      '<span class="ttl">🎨 画布</span>' +
      '<button class="cback" style="display:none">← 列表</button>' +
      '<button class="cclose">关闭 ✕</button>' +
    '</div>' +
    '<div class="canvas-body"><div class="canvas-empty">暂无 artifact<br>让 AI 创建网页 / 报告 / 图表试试</div></div>';
  app.appendChild(panel);

  var toggleBtn = document.createElement('button');
  toggleBtn.className = 'canvas-toggle';
  toggleBtn.textContent = '🎨 画布';
  topbar.appendChild(toggleBtn);

  var body = panel.querySelector('.canvas-body');
  var headTitle = panel.querySelector('.ttl');
  var backBtn = panel.querySelector('.cback');
  var currentId = null;

  function setOpen(open) {
    panel.classList.toggle('open', !!open);
    toggleBtn.classList.toggle('on', !!open);
  }
  function openPanel() { setOpen(true); }
  toggleBtn.addEventListener('click', function () { setOpen(!panel.classList.contains('open')); });
  panel.querySelector('.cclose').addEventListener('click', function () { setOpen(false); });
  backBtn.addEventListener('click', function () { showList(); });

  /* ---------- 渲染 ---------- */
  // svg 简单过滤：去掉 <script...> 标签与内联事件（防 XSS）
  function sanitizeSvg(s) {
    return String(s || '')
      .replace(/<\s*script[\s>][\s\S]*?<\s*\/\s*script\s*>/gi, '')
      .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');
  }

  function renderContent(row) {
    var wrap = document.createElement('div');
    var type = row.type;
    if (type === 'html') {
      // 红线：sandbox 只给 allow-scripts，绝不加 allow-same-origin
      var f = document.createElement('iframe');
      f.setAttribute('sandbox', 'allow-scripts');
      f.setAttribute('srcdoc', escapeHtml(row.content)); // 属性转义
      f.setAttribute('title', row.title || 'artifact');
      wrap.appendChild(f);
    } else if (type === 'markdown') {
      var md = document.createElement('div');
      md.className = 'md';
      md.innerHTML = renderMiniMarkdown(row.content);
      wrap.appendChild(md);
    } else if (type === 'svg') {
      var box = document.createElement('div');
      box.className = 'svgbox';
      box.innerHTML = sanitizeSvg(row.content);
      wrap.appendChild(box);
    } else {
      // code
      var pre = document.createElement('pre');
      pre.className = 'codebox';
      pre.textContent = row.content; // textContent 天然转义
      wrap.appendChild(pre);
    }
    return wrap;
  }

  function showArtifact(row) {
    currentId = row.id;
    headTitle.textContent = '🎨 ' + (row.title || '未命名');
    backBtn.style.display = '';
    body.innerHTML = '';
    var view = document.createElement('div');
    view.className = 'canvas-view';
    var h = document.createElement('h3');
    h.textContent = row.title || '未命名'; // 标题一律转义
    var badge = document.createElement('span');
    badge.className = 'atype ' + (row.type || '');
    badge.textContent = TYPE_LABEL[row.type] || row.type;
    h.appendChild(document.createTextNode(' '));
    h.appendChild(badge);
    view.appendChild(h);
    view.appendChild(renderContent(row));
    body.appendChild(view);
  }

  function showList() {
    currentId = null;
    headTitle.textContent = '🎨 画布';
    backBtn.style.display = 'none';
    body.innerHTML = '<div class="canvas-empty">加载中…</div>';
    fetch('/api/artifacts', { credentials: 'same-origin' })
      .then(function (r) {
        if (!r.ok) throw new Error('加载失败（' + r.status + '）');
        return r.json();
      })
      .then(function (rows) {
        body.innerHTML = '';
        if (!rows || !rows.length) {
          body.innerHTML = '<div class="canvas-empty">暂无 artifact<br>让 AI 创建网页 / 报告 / 图表试试</div>';
          return;
        }
        rows.forEach(function (row) {
          var item = document.createElement('div');
          item.className = 'canvas-item' + (row.id === currentId ? ' active' : '');
          var t = document.createElement('span');
          t.className = 't';
          t.textContent = row.title || '未命名';
          var badge = document.createElement('span');
          badge.className = 'atype ' + (row.type || '');
          badge.textContent = TYPE_LABEL[row.type] || row.type;
          var time = document.createElement('span');
          time.className = 'time';
          time.textContent = fmtTime(row.updated_at || row.created_at);
          var del = document.createElement('button');
          del.className = 'adel';
          del.textContent = '×';
          del.title = '删除';
          del.addEventListener('click', function (ev) {
            ev.stopPropagation();
            if (!window.confirm('确定删除「' + (row.title || '未命名') + '」吗？')) return;
            fetch('/api/artifacts/' + encodeURIComponent(row.id), {
              method: 'DELETE', credentials: 'same-origin'
            }).then(function (r) {
              if (!r.ok) throw new Error('删除失败（' + r.status + '）');
              showList();
            }).catch(function (e) { window.alert(e.message); });
          });
          item.appendChild(badge);
          item.appendChild(t);
          item.appendChild(time);
          item.appendChild(del);
          item.addEventListener('click', function () { openArtifact(row.id); });
          body.appendChild(item);
        });
      })
      .catch(function (e) {
        body.innerHTML = '<div class="canvas-err">' + escapeHtml(e.message) + '</div>';
      });
  }

  function openArtifact(id) {
    body.innerHTML = '<div class="canvas-empty">加载中…</div>';
    fetch('/api/artifacts/' + encodeURIComponent(id), { credentials: 'same-origin' })
      .then(function (r) {
        if (r.status === 404) throw new Error('artifact 不存在');
        if (!r.ok) throw new Error('加载失败（' + r.status + '）');
        return r.json();
      })
      .then(function (row) {
        openPanel();
        showArtifact(row);
      })
      .catch(function (e) {
        body.innerHTML = '<div class="canvas-err">' + escapeHtml(e.message) + '</div>';
      });
  }

  /* ---------- 事件：agent 的 artifact SSE 事件 → 打开画布 ---------- */
  window.addEventListener('openmuse:artifact', function (ev) {
    var d = (ev && ev.detail) || {};
    if (!d.id) return;
    openArtifact(d.id);
  });

  // 面板首次打开时拉列表
  var firstOpen = true;
  var origSetOpen = setOpen;
  setOpen = function (open) {
    origSetOpen(open);
    if (open && firstOpen) { firstOpen = false; showList(); }
  };

  // 暴露给调试
  window.openmuseCanvas = { openPanel: openPanel, showList: showList, openArtifact: openArtifact };
})();
