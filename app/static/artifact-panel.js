/* openmuse P1 Worker B — Artifacts 画布前端面板。
 *
 * 自包含 classic script：不依赖 index.html 的任何函数（只读其消息 DOM 结构，
 * 通过 #inner .msg.ai 查询插入卡片），自带 escapeHtml 与极简 markdown 渲染。
 * coordinator 只需在 index.html 中：
 *   <script src="/artifact-panel.js"></script>
 * 并在 doSend 的 SSE 分发里加：
 *   else if(o.t==='artifact'){window.dispatchEvent(new CustomEvent('openmuse:artifact',{detail:o}));}
 *
 * 功能：
 *   - 420px 右侧抽屉（预览/代码 tab + 全屏按钮）
 *   - 全屏画布覆盖层（fixed inset-0，Esc 关闭）
 *   - 消息流内嵌 artifact 卡片（html 类型带缩放实时缩略图）
 *
 * 安全红线：
 *   html 类型一律 <iframe sandbox="allow-scripts" srcdoc="...">，
 *   绝不加 allow-same-origin（opaque origin，防 XSS）；
 *   标题一律 textContent 或转义后 innerHTML。
 *
 * 纯逻辑抽在 ArtifactCore 里（无 DOM 依赖），node 可直接 require 测试：
 *   node test/artifact-panel.test.js
 */

/* ============ 可测纯逻辑（无 DOM 依赖） ============ */
var ArtifactCore = (function () {
  'use strict';

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
        if (!inList) { html += '</ul>'; inList = true; }
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

  // 类型徽标文案；未知类型回退显示原值
  function typeLabel(type) {
    if (type == null) return '';
    return TYPE_LABEL[type] || String(type);
  }

  // 类型徽标 class；调用方用 className 赋值（非 innerHTML），无需转义
  function typeClass(type) {
    return 'atype ' + (type || '');
  }

  // 预览/代码 tab 状态归一化：非法输入一律回退到 preview
  function resolveViewTab(tab) {
    return tab === 'code' ? 'code' : 'preview';
  }

  // 代码视图 HTML：走 innerHTML 前必须先 escapeHtml（这里转义是正确的）
  function codeViewHtml(src) {
    return '<pre class="codebox">' + escapeHtml(src) + '</pre>';
  }

  // 缩略图 iframe 内联样式：4 倍尺寸 + scale(0.25) 铺满 140px 高容器，
  // pointer-events:none 让它不拦截消息流的点击
  function thumbnailStyle() {
    return 'width:400%;height:560px;border:0;display:block;' +
      'transform:scale(0.25);transform-origin:top left;pointer-events:none;';
  }

  // Esc 关闭逻辑：输入框/文本域聚焦时不抢
  function shouldHandleEscKey(tagName) {
    var t = String(tagName || '').toUpperCase();
    return t !== 'INPUT' && t !== 'TEXTAREA';
  }

  // svg 简单过滤：去掉 <script...> 标签与内联事件（防 XSS）
  function sanitizeSvg(s) {
    return String(s || '')
      .replace(/<\s*script[\s>][\s\S]*?<\s*\/\s*script\s*>/gi, '')
      .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');
  }

  return {
    escapeHtml: escapeHtml,
    renderMiniMarkdown: renderMiniMarkdown,
    fmtTime: fmtTime,
    TYPE_LABEL: TYPE_LABEL,
    typeLabel: typeLabel,
    typeClass: typeClass,
    resolveViewTab: resolveViewTab,
    codeViewHtml: codeViewHtml,
    thumbnailStyle: thumbnailStyle,
    shouldHandleEscKey: shouldHandleEscKey,
    sanitizeSvg: sanitizeSvg
  };
})();

// node 测试：module.exports；浏览器：挂到 window 供调试
if (typeof module !== 'undefined' && module.exports) {
  module.exports = ArtifactCore;
} else if (typeof window !== 'undefined') {
  window.openmuseArtifactCore = ArtifactCore;
}

/* ============ DOM 面板（浏览器） ============ */
(function () {
  'use strict';
  // node 下无 document：纯逻辑已在上面导出，这里直接退出
  if (typeof document === 'undefined' || typeof window === 'undefined') return;

  var core = ArtifactCore;
  var escapeHtml = core.escapeHtml;
  var renderMiniMarkdown = core.renderMiniMarkdown;
  var fmtTime = core.fmtTime;
  var sanitizeSvg = core.sanitizeSvg;

  /* ---------- 样式（贴近现有深色主题） ---------- */
  var css = [
    '.canvas-toggle{border:1px solid var(--border);background:var(--panel);color:var(--muted);',
    'border-radius:9px;padding:7px 14px;font-size:13px;cursor:pointer;transition:.15s;margin-left:auto;}',
    '.canvas-toggle:hover{color:var(--text);border-color:var(--accent);}',
    '.canvas-toggle.on{color:var(--accent2);border-color:var(--accent2);}',
    '.canvas-panel{width:420px;flex-shrink:0;background:var(--bg2);border-left:1px solid var(--border);',
    'display:none;flex-direction:column;min-height:0;z-index:15;}',
    '.canvas-panel.open{display:flex;}',
    '.canvas-head{display:flex;align-items:center;gap:8px;padding:12px 16px;border-bottom:1px solid var(--border);}',
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
    '.canvas-err{color:var(--danger);font-size:13px;padding:12px;}',
    /* 预览/代码 tab */
    '.vtabs{display:flex;gap:6px;flex-shrink:0;}',
    '.vtab{border:1px solid var(--border);background:transparent;color:var(--muted);border-radius:8px;',
    'padding:5px 12px;font-size:12px;cursor:pointer;transition:.15s;}',
    '.vtab:hover{color:var(--text);border-color:var(--accent);}',
    '.vtab.on{color:var(--accent2);border-color:var(--accent2);background:rgba(56,225,198,.08);}',
    /* 消息流内嵌 artifact 卡片 */
    '.acard{border:1px solid var(--border);border-radius:12px;background:rgba(255,255,255,.02);',
    'margin:12px 0;overflow:hidden;}',
    '.acard-row{display:flex;align-items:center;gap:10px;padding:10px 12px;}',
    '.acard-title{flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:13.5px;}',
    '.acard-actions{display:flex;gap:8px;flex-shrink:0;}',
    '.acard-actions button{border:1px solid var(--border);background:var(--panel);color:var(--muted);',
    'border-radius:8px;padding:4px 10px;font-size:12px;cursor:pointer;transition:.15s;}',
    '.acard-actions button:hover{color:var(--text);border-color:var(--accent);}',
    '.acard-thumb{height:140px;overflow:hidden;border-top:1px solid var(--border);background:#fff;}',
    /* 全屏画布覆盖层 */
    '.afull{position:fixed;inset:0;z-index:9999;background:var(--bg);display:none;flex-direction:column;}',
    '.afull.open{display:flex;}',
    '.afull-head{display:flex;align-items:center;gap:10px;padding:12px 18px;border-bottom:1px solid var(--border);}',
    '.afull-head .ttl{font-size:15px;font-weight:700;flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
    '.afull-head button{border:1px solid var(--border);background:var(--panel);color:var(--muted);',
    'border-radius:8px;padding:5px 12px;font-size:12px;cursor:pointer;}',
    '.afull-head button:hover{color:var(--text);border-color:var(--accent);}',
    '.afull-body{flex:1;overflow:auto;padding:18px;}',
    '.afull-body .awrap{max-width:1100px;margin:0 auto;}',
    '.afull-body iframe{width:100%;height:calc(100vh - 170px);min-height:480px;border:1px solid var(--border);',
    'border-radius:12px;background:#fff;}',
    '.afull-body .svgbox{border:1px solid var(--border);border-radius:12px;background:#fff;',
    'padding:16px;display:flex;justify-content:center;}',
    '.afull-body .codebox{margin:0;border:1px solid var(--border);border-radius:12px;overflow:auto;',
    'background:#0a0d13;padding:16px;font-size:13px;line-height:1.7;white-space:pre-wrap;word-break:break-all;}',
    '.afull-body .md h2,.afull-body .md h3,.afull-body .md h4{margin:14px 0 8px;}',
    '.afull-body .md p{margin:0 0 10px;word-break:break-word;}',
    '.afull-body .md ul{margin:0 0 10px;padding-left:20px;}',
    '.afull-body .md code{background:rgba(255,255,255,.07);padding:1px 6px;border-radius:5px;font-size:13px;}',
    '.afull-body .md a{color:var(--accent2);}'
  ].join('\n');
  var style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);

  /* ---------- DOM：开关按钮 + 右侧面板 + 全屏层 ---------- */
  var topbar = document.querySelector('.topbar');
  var app = document.querySelector('.app');
  if (!topbar || !app) return; // 结构不符则静默退出，不破坏现有页面

  var panel = document.createElement('aside');
  panel.className = 'canvas-panel';
  panel.innerHTML =
    '<div class="canvas-head">' +
      '<span class="ttl">🎨 画布</span>' +
      '<div class="vtabs dtabs" style="display:none">' +
        '<button class="vtab on" data-tab="preview">预览</button>' +
        '<button class="vtab" data-tab="code">代码</button>' +
      '</div>' +
      '<button class="cfull" style="display:none">⛶ 全屏</button>' +
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
  var fullBtn = panel.querySelector('.cfull');
  var dtabs = panel.querySelector('.dtabs');
  var currentId = null;
  var currentRow = null;
  var viewTab = 'preview';

  // 全屏覆盖层
  var fs = document.createElement('div');
  fs.className = 'afull';
  fs.innerHTML =
    '<div class="afull-head">' +
      '<span class="ttl"></span>' +
      '<div class="vtabs ftabs">' +
        '<button class="vtab on" data-tab="preview">预览</button>' +
        '<button class="vtab" data-tab="code">代码</button>' +
      '</div>' +
      '<button class="fclose">关闭 ✕</button>' +
    '</div>' +
    '<div class="afull-body"><div class="awrap"></div></div>';
  document.body.appendChild(fs);
  var fsTitle = fs.querySelector('.ttl');
  var fsBody = fs.querySelector('.awrap');
  var ftabs = fs.querySelector('.ftabs');
  var fsRow = null;
  var fsTab = 'preview';

  function setOpen(open) {
    panel.classList.toggle('open', !!open);
    toggleBtn.classList.toggle('on', !!open);
  }
  function openPanel() { setOpen(true); }
  toggleBtn.addEventListener('click', function () { setOpen(!panel.classList.contains('open')); });
  panel.querySelector('.cclose').addEventListener('click', function () { setOpen(false); });
  backBtn.addEventListener('click', function () { showList(); });
  fullBtn.addEventListener('click', function () { if (currentId) openFullscreen(currentId); });

  /* ---------- 数据 ---------- */
  function fetchArtifact(id) {
    return fetch('/api/artifacts/' + encodeURIComponent(id), { credentials: 'same-origin' })
      .then(function (r) {
        if (r.status === 404) throw new Error('artifact 不存在');
        if (!r.ok) throw new Error('加载失败（' + r.status + '）');
        return r.json();
      });
  }

  /* ---------- 渲染 ---------- */
  function renderContent(row) {
    var wrap = document.createElement('div');
    var type = row.type;
    if (type === 'html') {
      // 红线：sandbox 只给 allow-scripts，绝不加 allow-same-origin。
      // P0 修复：setAttribute 是 DOM API，浏览器自己处理转义，
      // 包一层 escapeHtml 会让 srcdoc 字面变成 &lt;!DOCTYPE… 从而只显示源码。
      var f = document.createElement('iframe');
      f.setAttribute('sandbox', 'allow-scripts');
      f.setAttribute('srcdoc', row.content);
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

  // 代码视图：走 innerHTML，所以先用 escapeHtml 转义（这里转义是正确的）
  function renderCodeView(row, mount) {
    var div = document.createElement('div');
    div.innerHTML = core.codeViewHtml(row.content);
    mount.appendChild(div.firstChild);
  }

  function makeHeader(row) {
    var h = document.createElement('h3');
    h.textContent = row.title || '未命名'; // 标题一律转义
    var badge = document.createElement('span');
    badge.className = core.typeClass(row.type);
    badge.textContent = core.typeLabel(row.type);
    h.appendChild(document.createTextNode(' '));
    h.appendChild(badge);
    return h;
  }

  function bindTabs(tabBox, getTab, setTab) {
    var tabs = tabBox.querySelectorAll('.vtab');
    for (var i = 0; i < tabs.length; i++) {
      (function (btn) {
        btn.addEventListener('click', function () {
          setTab(core.resolveViewTab(btn.getAttribute('data-tab')));
          for (var j = 0; j < tabs.length; j++) {
            tabs[j].classList.toggle('on', tabs[j].getAttribute('data-tab') === getTab());
          }
        });
      })(tabs[i]);
    }
  }
  function syncTabs(tabBox, tab) {
    var tabs = tabBox.querySelectorAll('.vtab');
    for (var i = 0; i < tabs.length; i++) {
      tabs[i].classList.toggle('on', tabs[i].getAttribute('data-tab') === tab);
    }
  }

  /* ----- 抽屉：预览/代码 ----- */
  function renderDrawerView() {
    body.innerHTML = '';
    var view = document.createElement('div');
    view.className = 'canvas-view';
    view.appendChild(makeHeader(currentRow));
    if (viewTab === 'code') renderCodeView(currentRow, view);
    else view.appendChild(renderContent(currentRow));
    body.appendChild(view);
  }

  function showArtifact(row) {
    currentId = row.id;
    currentRow = row;
    viewTab = 'preview';
    syncTabs(dtabs, viewTab);
    headTitle.textContent = '🎨 ' + (row.title || '未命名');
    backBtn.style.display = '';
    fullBtn.style.display = '';
    dtabs.style.display = '';
    renderDrawerView();
  }

  function showList() {
    currentId = null;
    currentRow = null;
    headTitle.textContent = '🎨 画布';
    backBtn.style.display = 'none';
    fullBtn.style.display = 'none';
    dtabs.style.display = 'none';
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
          badge.className = core.typeClass(row.type);
          badge.textContent = core.typeLabel(row.type);
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

  // 面板首次打开时拉列表；若直接打开指定工件，openArtifact 会先把 firstOpen 置 false，
  // 避免 showList 的异步返回覆盖掉工件渲染（2026-10-02 审计发现的竞态）
  var firstOpen = true;
  function openArtifact(id) {
    body.innerHTML = '<div class="canvas-empty">加载中…</div>';
    fetchArtifact(id)
      .then(function (row) {
        firstOpen = false;
        openPanel();
        showArtifact(row);
      })
      .catch(function (e) {
        body.innerHTML = '<div class="canvas-err">' + escapeHtml(e.message) + '</div>';
      });
  }

  /* ----- 全屏：预览/代码 ----- */
  function renderFullscreenView() {
    fsBody.innerHTML = '';
    if (fsTab === 'code') renderCodeView(fsRow, fsBody);
    else fsBody.appendChild(renderContent(fsRow));
  }

  function openFullscreen(id) {
    fsTitle.textContent = '加载中…';
    fsTab = 'preview';
    syncTabs(ftabs, fsTab);
    fsBody.innerHTML = '<div class="canvas-empty">加载中…</div>';
    fs.classList.add('open');
    fetchArtifact(id)
      .then(function (row) {
        fsRow = row;
        fsTitle.textContent = row.title || '未命名';
        renderFullscreenView();
      })
      .catch(function (e) {
        fsBody.innerHTML = '<div class="canvas-err">' + escapeHtml(e.message) + '</div>';
      });
  }

  function closeFullscreen() {
    fs.classList.remove('open');
    fsRow = null;
  }

  fs.querySelector('.fclose').addEventListener('click', closeFullscreen);
  bindTabs(dtabs,
    function () { return viewTab; },
    function (t) { viewTab = t; if (currentRow) renderDrawerView(); });
  bindTabs(ftabs,
    function () { return fsTab; },
    function (t) { fsTab = t; if (fsRow) renderFullscreenView(); });

  /* ---------- 消息流内嵌 artifact 卡片 ---------- */
  function lastAiMsgBody() {
    // 只读 index.html 现有结构：#inner 下的 .msg.ai，最后一条即当前流式消息
    var msgs = document.querySelectorAll('#inner .msg.ai');
    if (!msgs.length) return null;
    var msg = msgs[msgs.length - 1];
    return msg.querySelector('.body') || msg;
  }

  function lazyRenderThumbnail(thumb, id) {
    var done = false;
    function render() {
      if (done || !document.contains(thumb)) return;
      done = true;
      fetchArtifact(id).then(function (row) {
        var f = document.createElement('iframe');
        // 红线：sandbox 只给 allow-scripts，绝不加 allow-same-origin
        f.setAttribute('sandbox', 'allow-scripts');
        f.setAttribute('srcdoc', row.content); // setAttribute 是 DOM API，浏览器处理转义
        f.setAttribute('title', 'artifact 缩略图');
        f.style.cssText = core.thumbnailStyle();
        thumb.appendChild(f);
      }).catch(function () {
        thumb.style.display = 'none'; // 拉不到内容就不占位
      });
    }
    if (typeof IntersectionObserver !== 'undefined') {
      // 进入视口附近 200px 再渲染，避免阻塞消息流；3s 兜底
      var io = new IntersectionObserver(function (ents, obs) {
        for (var i = 0; i < ents.length; i++) {
          if (ents[i].isIntersecting) { obs.disconnect(); render(); return; }
        }
      }, { rootMargin: '200px' });
      io.observe(thumb);
      setTimeout(function () { io.disconnect(); render(); }, 3000);
    } else {
      setTimeout(render, 300);
    }
  }

  function buildArtifactCard(d) {
    var card = document.createElement('div');
    card.className = 'acard';
    card.setAttribute('data-artifact-id', d.id);
    var row = document.createElement('div');
    row.className = 'acard-row';
    var badge = document.createElement('span');
    badge.className = core.typeClass(d.type);
    badge.textContent = core.typeLabel(d.type);
    var title = document.createElement('span');
    title.className = 'acard-title';
    title.textContent = d.title || '未命名'; // 标题一律转义
    var acts = document.createElement('div');
    acts.className = 'acard-actions';
    var bOpen = document.createElement('button');
    bOpen.textContent = '画布打开';
    bOpen.addEventListener('click', function () { openArtifact(d.id); });
    var bFull = document.createElement('button');
    bFull.textContent = '全屏';
    bFull.addEventListener('click', function () { openFullscreen(d.id); });
    acts.appendChild(bOpen);
    acts.appendChild(bFull);
    row.appendChild(badge);
    row.appendChild(title);
    row.appendChild(acts);
    card.appendChild(row);
    // html 类型：缩放实时缩略图（懒渲染）
    if (d.type === 'html') {
      var thumb = document.createElement('div');
      thumb.className = 'acard-thumb';
      card.appendChild(thumb);
      lazyRenderThumbnail(thumb, d.id);
    }
    return card;
  }

  function insertArtifactCard(d) {
    if (!d.id) return;
    var target = lastAiMsgBody();
    if (!target) return;
    // 同一条消息里同一 artifact 只插一张卡片
    var cards = target.querySelectorAll('.acard');
    for (var i = 0; i < cards.length; i++) {
      if (cards[i].getAttribute('data-artifact-id') === d.id) return;
    }
    target.appendChild(buildArtifactCard(d));
  }

  /* ---------- 事件：agent 的 artifact SSE 事件 → 卡片 + 打开画布 ---------- */
  window.addEventListener('openmuse:artifact', function (ev) {
    var d = (ev && ev.detail) || {};
    if (!d.id) return;
    insertArtifactCard(d);
    openArtifact(d.id);
  });

  // 面板首次打开时拉列表（firstOpen 声明见 openArtifact 上方）
  var origSetOpen = setOpen;
  setOpen = function (open) {
    origSetOpen(open);
    if (open && firstOpen) { firstOpen = false; showList(); }
  };

  // 暴露给调试
  window.openmuseCanvas = {
    openPanel: openPanel, showList: showList,
    openArtifact: openArtifact, openFullscreen: openFullscreen,
    closeFullscreen: closeFullscreen, insertArtifactCard: insertArtifactCard
  };
  // P2-5：Esc 关闭画布（输入框聚焦时不抢；任务面板的 Esc 由 task-panel.js 处理）
  // 全屏层优先关闭，其次才是 420px 抽屉
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    var t = e.target;
    if (!core.shouldHandleEscKey(t && t.tagName)) return;
    if (fs.classList.contains('open')) { closeFullscreen(); return; }
    if (panel.classList.contains('open')) setOpen(false);
  });
})();
