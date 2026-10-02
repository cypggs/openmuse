// openmuse — 主聊/旁聊纯逻辑（无 DB、无网络、无 DOM）。
//
// 与 app/static/index.html 内的浏览器副本保持一致：改这里必须同步改那里的
// groupSides/fallbackTitle（浏览器用不了 CommonJS）。
//
// 运行测试：node test/sidechat.test.js
'use strict';

const DAY_MS = 24 * 60 * 60 * 1000;

function startOfLocalDay(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

// 按 今天/昨天/近 7 天/更早 分组（本地日历日边界）。
// sides: [{ id, title, created_at }]；created_at 可为 Date 或 ISO 字符串。
// now: 可注入的时间戳（测试用），默认 Date.now()。
// 返回 [{ label, items }]，只保留非空组，顺序固定。
function groupSides(sides, now) {
  const t = now == null ? Date.now() : new Date(now).getTime();
  const dayStart = startOfLocalDay(t);
  const groups = [
    { label: '今天', items: [] },
    { label: '昨天', items: [] },
    { label: '近 7 天', items: [] },
    { label: '更早', items: [] },
  ];
  (sides || []).forEach((s) => {
    const ts = new Date(s && s.created_at).getTime();
    let g;
    if (Number.isNaN(ts)) g = groups[3]; // created_at 非法 → 归入更早，不丢数据
    else if (ts >= dayStart) g = groups[0];
    else if (ts >= dayStart - DAY_MS) g = groups[1];
    else if (ts >= dayStart - 7 * DAY_MS) g = groups[2];
    else g = groups[3];
    g.items.push(s);
  });
  return groups.filter((g) => g.items.length > 0);
}

// 首条用户消息前 18 字（按字符计，emoji/CJK 各算 1）。
// 空消息/纯空白回退为 '新的对话'。
function fallbackTitle(msg) {
  const text = String(msg == null ? '' : msg).trim();
  if (!text) return '新的对话';
  return Array.from(text).slice(0, 18).join('');
}

module.exports = { groupSides, fallbackTitle, DAY_MS };
