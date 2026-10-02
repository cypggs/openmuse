/* openmuse P1-3 — 工具活动叙事步骤流。
 *
 * 自包含 classic script：不依赖 index.html 的任何函数，自带 escapeHtml。
 * coordinator 只需在 index.html 中：
 *   <script src="/toolsteps.js"></script>
 * 并在 doSend 的 SSE 分发里把原 toolStart/toolEnd 调用换成：
 *   else if(o.t==='tool_start'){window.dispatchEvent(new CustomEvent('openmuse:tool',{detail:{phase:'start',id:o.id,label:o.label}}));}
 *   else if(o.t==='tool_end'){window.dispatchEvent(new CustomEvent('openmuse:tool',{detail:{phase:'end',id:o.id,label:o.label,ok:o.ok,output:o.output,summary:o.summary}}));}
 *
 * 视觉与现有 .toolcard chip 统一：同卡片、同圆点语义、同 mono 字体，
 * 只是纵向排成步骤流：左侧时间线导轨 + 状态圆点（转圈→✓/✗）+ label
 * + summary + 默认收起的 output（截断 500 字）。
 */
(function () {
  'use strict';

  /* ---------- 自带工具 ---------- */
  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* ---------- 样式（复用 index.html 的 .toolcard 视觉语言） ---------- */
  var css = [
    /* 左侧时间线导轨：纵向步骤流 */
    '.tools.stepflow{position:relative;border-left:2px solid var(--border);',
    'padding-left:12px;margin:10px 0 10px 8px;}',
    '.tools.stepflow .toolcard{margin:8px 0;}',
    /* summary 行：比 label 更淡的一行叙事 */
    '.toolcard .tsum{padding:0 10px 8px 26px;font-size:12.5px;color:var(--muted);',
    'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
    /* 状态圆点放大以便放 ✓/✗；run 态沿用 index.html 的呼吸动画 */
    '.tools.stepflow .tdot{width:16px;height:16px;font-size:10px;line-height:16px;',
    'text-align:center;color:#fff;flex-shrink:0;}',
    '.tools.stepflow .tdot.run{line-height:0;}', // 转圈时不显示字形
    '.tools.stepflow .toolhead{gap:10px;}'
  ].join('\n');
  var style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);

  /* ---------- 定位当前 assistant 消息 ---------- */
  function currentTools() {
    var bodies = document.querySelectorAll('#inner .msg.ai .body');
    if (!bodies.length) return null;
    return bodies[bodies.length - 1].querySelector('.tools');
  }
  function findCard(id) {
    return document.getElementById('tc_' + id);
  }
  function scrollTools(tools) {
    try {
      var scroller = tools;
      while (scroller && scroller !== document.body) {
        scroller = scroller.parentElement;
        if (scroller && scroller.scrollHeight > scroller.clientHeight + 90) {
          if (scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 90) {
            scroller.scrollTop = scroller.scrollHeight;
          }
          break;
        }
      }
    } catch (_) {}
  }

  /* ---------- 渲染 ---------- */
  function onStart(d) {
    var tools = currentTools();
    if (!tools) return;
    tools.classList.add('stepflow');
    if (findCard(d.id)) return; // 重复 start 只建一次

    var el = document.createElement('div');
    el.className = 'toolcard step';
    el.id = 'tc_' + d.id;

    var head = document.createElement('div');
    head.className = 'toolhead';
    var dot = document.createElement('span');
    dot.className = 'tdot run';
    var lab = document.createElement('span');
    lab.className = 'tlabel';
    lab.textContent = d.label || '执行工具';
    var tg = document.createElement('button');
    tg.className = 'ttoggle';
    tg.title = '展开/折叠输出';
    tg.textContent = '▸';
    head.appendChild(dot);
    head.appendChild(lab);
    head.appendChild(tg);

    var sum = document.createElement('div');
    sum.className = 'tsum';
    sum.style.display = 'none';

    var body = document.createElement('div');
    body.className = 'tbody';
    body.style.display = 'none';
    var pre = document.createElement('pre');
    body.appendChild(pre);

    function toggle() {
      var open = body.style.display !== 'none';
      body.style.display = open ? 'none' : 'block';
      tg.textContent = open ? '▸' : '▾';
    }
    tg.addEventListener('click', function (ev) { ev.stopPropagation(); toggle(); });
    head.addEventListener('click', toggle);

    el.appendChild(head);
    el.appendChild(sum);
    el.appendChild(body);
    tools.appendChild(el);
    scrollTools(tools);
  }

  function onEnd(d) {
    var el = findCard(d.id);
    if (!el) {
      // start 事件丢失时的兜底：先补建卡片
      onStart(d);
      el = findCard(d.id);
      if (!el) return;
    }
    var dot = el.querySelector('.tdot');
    dot.className = 'tdot ' + (d.ok ? 'ok' : 'fail');
    dot.textContent = d.ok ? '✓' : '✗';

    var sum = el.querySelector('.tsum');
    if (d.summary) {
      sum.textContent = d.summary; // textContent 天然转义
      sum.style.display = 'block';
    }

    var pre = el.querySelector('.tbody pre');
    var out = d.output == null || d.output === '' ? '(无输出)' : String(d.output);
    pre.textContent = out.length > 500
      ? out.slice(0, 500) + '…（已截断，共 ' + out.length + ' 字）'
      : out;

    scrollTools(el.parentElement);
  }

  /* ---------- 事件入口 ---------- */
  window.addEventListener('openmuse:tool', function (ev) {
    var d = (ev && ev.detail) || {};
    if (!d.id) return;
    if (d.phase === 'start') onStart(d);
    else if (d.phase === 'end') onEnd(d);
  });

  // 暴露给调试
  window.openmuseToolSteps = { onStart: onStart, onEnd: onEnd };
})();
