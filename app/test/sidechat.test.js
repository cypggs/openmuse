// openmuse 主聊/旁聊 — 纯逻辑单元测试（node + assert）。
// 运行：node test/sidechat.test.js
'use strict';

// 分组按本地日历日计算：钉住时区，保证边界测试与用户浏览器（Asia/Shanghai）一致。
process.env.TZ = 'Asia/Shanghai';

const assert = require('assert');
const { groupSides, fallbackTitle } = require('../lib/sidechat');

let passed = 0;
let failed = 0;
const failures = [];

async function t(name, fn) {
  try {
    await fn();
    passed++;
    console.log('  ✓ ' + name);
  } catch (e) {
    failed++;
    failures.push({ name, err: e });
    console.log('  ✗ ' + name + ' → ' + (e && e.message ? e.message : String(e)));
  }
}

function mk(id, iso) {
  return { id, title: 't-' + id, created_at: iso };
}
function labels(groups) {
  return groups.map((g) => g.label);
}
function itemsOf(groups, label) {
  const g = groups.find((x) => x.label === label);
  return g ? g.items.map((s) => s.id) : [];
}

(async () => {
  console.log('groupSides:');

  await t('基本分组：今天/昨天/近7天/更早', () => {
    const now = '2026-10-02T14:00:00+08:00';
    const sides = [
      mk('today', '2026-10-02T09:00:00+08:00'),
      mk('yesterday', '2026-10-01T20:00:00+08:00'),
      mk('week', '2026-09-27T10:00:00+08:00'), // 5 天前
      mk('older', '2026-09-10T10:00:00+08:00'),
    ];
    const g = groupSides(sides, now);
    assert.deepStrictEqual(labels(g), ['今天', '昨天', '近 7 天', '更早']);
    assert.deepStrictEqual(itemsOf(g, '今天'), ['today']);
    assert.deepStrictEqual(itemsOf(g, '昨天'), ['yesterday']);
    assert.deepStrictEqual(itemsOf(g, '近 7 天'), ['week']);
    assert.deepStrictEqual(itemsOf(g, '更早'), ['older']);
  });

  await t('跨午夜边界：午夜前 1 分钟 → 昨天，午夜后 1 秒钟 → 今天', () => {
    const now = '2026-10-02T00:00:30+08:00'; // 刚过午夜 30 秒
    const g = groupSides(
      [mk('a', '2026-10-01T23:59:00+08:00'), mk('b', '2026-10-02T00:00:10+08:00')],
      now
    );
    assert.deepStrictEqual(labels(g), ['今天', '昨天']);
    assert.deepStrictEqual(itemsOf(g, '今天'), ['b']);
    assert.deepStrictEqual(itemsOf(g, '昨天'), ['a']);
  });

  await t('7 天边界：恰好 7 天前 → 近 7 天，7 天零 1 秒前 → 更早', () => {
    const now = '2026-10-02T12:00:00+08:00';
    const g = groupSides(
      [mk('edge', '2026-09-25T00:00:00+08:00'), mk('out', '2026-09-24T23:59:59+08:00')],
      now
    );
    assert.deepStrictEqual(itemsOf(g, '近 7 天'), ['edge']);
    assert.deepStrictEqual(itemsOf(g, '更早'), ['out']);
  });

  await t('空数组 → 空分组', () => {
    assert.deepStrictEqual(groupSides([], '2026-10-02T12:00:00+08:00'), []);
  });

  await t('created_at 非法 → 不丢数据，归入更早', () => {
    const g = groupSides([mk('bad', 'not-a-date')], '2026-10-02T12:00:00+08:00');
    assert.deepStrictEqual(itemsOf(g, '更早'), ['bad']);
  });

  await t('组内顺序保持输入顺序', () => {
    const now = '2026-10-02T14:00:00+08:00';
    const g = groupSides(
      [mk('s1', '2026-10-02T13:00:00+08:00'), mk('s2', '2026-10-02T10:00:00+08:00')],
      now
    );
    assert.deepStrictEqual(itemsOf(g, '今天'), ['s1', 's2']);
  });

  console.log('fallbackTitle:');

  await t('18 字截断（中文）', () => {
    assert.strictEqual(fallbackTitle('这是一个非常长的用户问题需要被截断到十八个字以内'), '这是一个非常长的用户问题需要被截断到');
  });

  await t('不足 18 字 → 原样返回', () => {
    assert.strictEqual(fallbackTitle('你好'), '你好');
  });

  await t('emoji 按字符计数（不拆 surrogate pair）', () => {
    const msg = '🚀'.repeat(20) + 'x';
    const r = fallbackTitle(msg);
    assert.strictEqual(Array.from(r).length, 18);
    assert.strictEqual(r, '🚀'.repeat(18));
  });

  await t('空消息/纯空白 → 新的对话', () => {
    assert.strictEqual(fallbackTitle(''), '新的对话');
    assert.strictEqual(fallbackTitle('   \n\t  '), '新的对话');
    assert.strictEqual(fallbackTitle(null), '新的对话');
    assert.strictEqual(fallbackTitle(undefined), '新的对话');
  });

  await t('首尾空白先 trim 再截断', () => {
    assert.strictEqual(fallbackTitle('  hello world  '), 'hello world');
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
})();
