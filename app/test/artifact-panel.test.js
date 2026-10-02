// openmuse Worker 1 — artifact-panel 纯逻辑测试（node + assert，不依赖浏览器 DOM）。
// 运行：node test/artifact-panel.test.js
'use strict';

const assert = require('assert');
const core = require('../static/artifact-panel.js');

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('  ✓ ' + name);
  } catch (e) {
    failed++;
    failures.push(name);
    console.log('  ✗ ' + name + ' → ' + (e && e.message ? e.message : String(e)));
  }
}

/* ---------- escapeHtml ---------- */
test('escapeHtml 转义 & < > " \'', () => {
  assert.strictEqual(core.escapeHtml('<a href="x">&\'y\'</a>'),
    '&lt;a href=&quot;x&quot;&gt;&amp;&#39;y&#39;&lt;/a&gt;');
});
test('escapeHtml 处理 null/undefined/数字', () => {
  assert.strictEqual(core.escapeHtml(null), '');
  assert.strictEqual(core.escapeHtml(undefined), '');
  assert.strictEqual(core.escapeHtml(123), '123');
});

/* ---------- typeLabel / typeClass（卡片徽标映射） ---------- */
test('typeLabel 映射四种类型', () => {
  assert.strictEqual(core.typeLabel('html'), '网页');
  assert.strictEqual(core.typeLabel('markdown'), '文档');
  assert.strictEqual(core.typeLabel('svg'), '矢量图');
  assert.strictEqual(core.typeLabel('code'), '代码');
});
test('typeLabel 未知类型回退原值、空值回退空串', () => {
  assert.strictEqual(core.typeLabel('pdf'), 'pdf');
  assert.strictEqual(core.typeLabel(null), '');
  assert.strictEqual(core.typeLabel(undefined), '');
});
test('typeClass 拼出徽标 class', () => {
  assert.strictEqual(core.typeClass('html'), 'atype html');
  assert.strictEqual(core.typeClass('markdown'), 'atype markdown');
  assert.strictEqual(core.typeClass(''), 'atype ');
});

/* ---------- resolveViewTab（预览/代码 tab 状态） ---------- */
test('resolveViewTab 只认 preview/code', () => {
  assert.strictEqual(core.resolveViewTab('preview'), 'preview');
  assert.strictEqual(core.resolveViewTab('code'), 'code');
});
test('resolveViewTab 非法输入回退 preview', () => {
  assert.strictEqual(core.resolveViewTab('源码'), 'preview');
  assert.strictEqual(core.resolveViewTab(undefined), 'preview');
  assert.strictEqual(core.resolveViewTab(null), 'preview');
  assert.strictEqual(core.resolveViewTab(''), 'preview');
});

/* ---------- codeViewHtml（代码视图：innerHTML 前必须转义） ---------- */
test('codeViewHtml 把源码转义进 pre', () => {
  const html = core.codeViewHtml('<script>alert(1)</script>');
  assert.ok(html.indexOf('<pre class="codebox">') === 0, '应以 pre.codebox 开头');
  assert.ok(html.indexOf('&lt;script&gt;') !== -1, '源码应被转义');
  assert.ok(html.indexOf('<script>') === -1, '不应出现未转义的 script 标签');
});
test('codeViewHtml 转义引号与 &', () => {
  const html = core.codeViewHtml('a="1" & b=\'2\'');
  assert.ok(html.indexOf('&quot;') !== -1);
  assert.ok(html.indexOf('&amp;') !== -1);
  assert.ok(html.indexOf('&#39;') !== -1);
});

/* ---------- thumbnailStyle（缩略图缩放） ---------- */
test('thumbnailStyle 含 scale(0.25) 与 pointer-events:none', () => {
  const s = core.thumbnailStyle();
  assert.ok(s.indexOf('scale(0.25)') !== -1, '应含 scale(0.25)');
  assert.ok(s.indexOf('pointer-events:none') !== -1, '不应拦截点击');
  assert.ok(s.indexOf('top left') !== -1, '缩放原点应为左上');
});
test('thumbnailStyle 无 allow-same-origin 字样（安全红线）', () => {
  assert.ok(core.thumbnailStyle().indexOf('same-origin') === -1);
});

/* ---------- shouldHandleEscKey（Esc 不抢输入框） ---------- */
test('shouldHandleEscKey 输入框/文本域不处理', () => {
  assert.strictEqual(core.shouldHandleEscKey('INPUT'), false);
  assert.strictEqual(core.shouldHandleEscKey('TEXTAREA'), false);
  assert.strictEqual(core.shouldHandleEscKey('input'), false); // 大小写不敏感
});
test('shouldHandleEscKey 其他元素可处理', () => {
  assert.strictEqual(core.shouldHandleEscKey('DIV'), true);
  assert.strictEqual(core.shouldHandleEscKey('BODY'), true);
  assert.strictEqual(core.shouldHandleEscKey(undefined), true);
});

/* ---------- sanitizeSvg（svg XSS 过滤） ---------- */
test('sanitizeSvg 去掉 script 标签', () => {
  const out = core.sanitizeSvg('<svg><script>alert(1)</script><rect/></svg>');
  assert.ok(out.indexOf('<script') === -1, 'script 应被移除');
  assert.ok(out.indexOf('<rect/>') !== -1, '正常图形应保留');
});
test('sanitizeSvg 去掉内联事件处理器', () => {
  const out = core.sanitizeSvg('<svg><rect onclick="evil()" onload=\'x\'/></svg>');
  assert.ok(out.indexOf('onclick') === -1, 'onclick 应被移除');
  assert.ok(out.indexOf('onload') === -1, 'onload 应被移除');
  assert.ok(out.indexOf('<rect') !== -1, 'rect 标签应保留');
});

/* ---------- renderMiniMarkdown（先转义再渲染） ---------- */
test('renderMiniMarkdown 转义 HTML 注入', () => {
  const out = core.renderMiniMarkdown('<script>alert(1)</script>');
  assert.ok(out.indexOf('<script>') === -1, '不应出现未转义 script');
  assert.ok(out.indexOf('&lt;script&gt;') !== -1, '应转义显示');
});
test('renderMiniMarkdown 行内语法可用', () => {
  const out = core.renderMiniMarkdown('# 标题\n- a\n- b\n**粗** `码`');
  assert.ok(out.indexOf('<h3>标题</h3>') !== -1);
  assert.ok(out.indexOf('<li>a</li>') !== -1);
  assert.ok(out.indexOf('<strong>粗</strong>') !== -1);
  assert.ok(out.indexOf('<code>码</code>') !== -1);
});

console.log('\n' + passed + ' 通过，' + failed + ' 失败（共 ' + (passed + failed) + '）');
if (failures.length) console.log('失败项：' + failures.join('；'));
process.exit(failed ? 1 : 0);
