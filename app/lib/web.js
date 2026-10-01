// openmuse 联网工具：web_search / web_read。
//
// - web_search：环境变量 BRAVE_API_KEY 存在时走 Brave Search API，
//   否则抓取 DuckDuckGo HTML 结果页并用正则解析。
// - web_read：抓取公网 http(s) 页面并提取正文，带 SSRF 防护。
//
// 安全约定：
// - 密钥只从 process.env 读取（BRAVE_API_KEY），绝不打日志、不写文件。
// - web_read 拒绝访问内网 / 回环 / 本地地址（见 isPrivateHost），
//   且跟随重定向后的最终地址会再检查一次。
// - 所有公开函数失败时返回 { error: '中文信息' }，绝不抛错。
// - 无新增 npm 依赖，只用 Node 原生 fetch / URL / AbortController。
'use strict';

const DDG_SEARCH_URL = 'https://html.duckduckgo.com/html/?q=';
const BRAVE_SEARCH_URL = 'https://api.search.brave.com/res/v1/web/search';
const UA = 'Mozilla/5.0 (compatible; openmuse/1.0)';

// DNS 解析器：默认用 dns.promises.lookup；测试可通过 setDnsLookup 注入桩，
// 避免测试做真实 DNS 查询。
let dnsLookupImpl = null;
function getDnsLookup() {
  if (dnsLookupImpl) return dnsLookupImpl;
  return require('dns').promises.lookup;
}
function setDnsLookup(fn) {
  dnsLookupImpl = typeof fn === 'function' ? fn : null;
}

// 请求超时毫秒数：默认 15000。WEB_FETCH_TIMEOUT_MS 仅供测试或运维调优覆盖。
function timeoutMs() {
  const v = Number(process.env.WEB_FETCH_TIMEOUT_MS);
  return Number.isFinite(v) && v > 0 ? v : 15000;
}

// 带超时的 fetch：超时后 AbortController 触发，fetch 以 AbortError 拒绝。
function fetchWithTimeout(url, options, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  const p = fetch(url, Object.assign({}, options, { signal: ctrl.signal }));
  return p.finally(() => clearTimeout(timer));
}

// 把 timeout / AbortError 统一转成中文错误信息。
function netError(e) {
  if (e && e.name === 'AbortError') return '请求超时';
  return '网络异常：' + (e && e.message ? e.message : String(e));
}

// HTML 实体解码（覆盖常见命名实体 + 数字实体）。
function decodeEntities(s) {
  return String(s).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, e) => {
    if (e[0] === '#') {
      const code =
        e[1] && e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    switch (e) {
      case 'amp': return '&';
      case 'lt': return '<';
      case 'gt': return '>';
      case 'quot': return '"';
      case 'apos': return "'";
      case 'nbsp': return ' ';
      default: return m;
    }
  });
}

// 去标签、解实体、压缩空白：用于标题和摘要的清洗。
function cleanText(s) {
  return decodeEntities(String(s).replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

// 从 DDG 结果链接中解出真实 URL。
// DDG 的结果链接形如 //duckduckgo.com/l/?uddg=<urlencoded>&rut=...。
function extractDdgUrl(href) {
  const h = String(href || '').replace(/&amp;/g, '&');
  const m = h.match(/[?&]uddg=([^&]*)/);
  if (m) {
    try {
      return decodeURIComponent(m[1]);
    } catch (_) {
      return m[1];
    }
  }
  if (h.startsWith('//')) return 'https:' + h; // 协议相对 URL 兜底
  return h;
}

// 正则解析 DDG HTML 结果页：result__a 拿标题+链接，result__snippet 拿摘要，按出现顺序配对。
function parseDdgHtml(html, count) {
  const links = [];
  const snippets = [];
  const aRe = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = aRe.exec(html))) {
    const attrs = m[1];
    const inner = m[2];
    if (/\bresult__a\b/.test(attrs)) {
      const hm = attrs.match(/\bhref="([^"]*)"/i);
      links.push({ href: hm ? hm[1] : '', title: cleanText(inner) });
    } else if (/\bresult__snippet\b/.test(attrs)) {
      snippets.push(cleanText(inner));
    }
  }
  const out = [];
  const n = Math.min(count, links.length);
  for (let i = 0; i < n; i++) {
    out.push({
      title: links[i].title,
      url: extractDdgUrl(links[i].href),
      snippet: snippets[i] || '',
    });
  }
  return out;
}

async function ddgSearch(query, count) {
  const url = DDG_SEARCH_URL + encodeURIComponent(query);
  let res;
  try {
    res = await fetchWithTimeout(url, { headers: { 'User-Agent': UA } }, timeoutMs());
  } catch (e) {
    return { error: '搜索' + netError(e) };
  }
  if (!res.ok) return { error: '搜索请求失败，HTTP ' + res.status };
  let html;
  try {
    html = await res.text();
  } catch (e) {
    return { error: '读取搜索结果失败：' + (e && e.message ? e.message : String(e)) };
  }
  try {
    return { results: parseDdgHtml(html, count) };
  } catch (e) {
    return { error: '解析搜索结果失败' };
  }
}

async function braveSearch(query, count) {
  const url =
    BRAVE_SEARCH_URL + '?q=' + encodeURIComponent(query) + '&count=' + count;
  let res;
  try {
    res = await fetchWithTimeout(
      url,
      {
        headers: {
          Accept: 'application/json',
          'X-Subscription-Token': process.env.BRAVE_API_KEY,
        },
      },
      timeoutMs()
    );
  } catch (e) {
    return { error: '搜索' + netError(e) };
  }
  if (!res.ok) return { error: '搜索服务返回 HTTP ' + res.status + '（请检查 BRAVE_API_KEY）' };
  let j;
  try {
    j = await res.json();
  } catch (e) {
    return { error: '解析搜索结果失败' };
  }
  const arr = j && Array.isArray(j.results) ? j.results : [];
  return {
    results: arr.slice(0, count).map((r) => ({
      title: cleanText(r.title || ''),
      url: String(r.url || ''),
      snippet: cleanText(r.description || ''),
    })),
  };
}

// 联网搜索。成功返回 { results: [{title, url, snippet}] }，失败返回 { error }。
async function web_search(query, count) {
  try {
    query = String(query == null ? '' : query).trim();
    if (!query) return { error: '搜索关键词为空' };
    count = Math.min(Math.max(parseInt(count, 10) || 8, 1), 20);
    if (process.env.BRAVE_API_KEY) return await braveSearch(query, count);
    return await ddgSearch(query, count);
  } catch (e) {
    return { error: '搜索失败：' + (e && e.message ? e.message : String(e)) };
  }
}

// 规范化主机名：小写、去首尾空白、去 IPv6 方括号、去末尾点。
function normHost(hostname) {
  let h = String(hostname == null ? '' : hostname).trim().toLowerCase();
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  if (h.endsWith('.')) h = h.slice(0, -1);
  return h;
}

function isPrivateIPv4(ip) {
  const parts = String(ip).split('.');
  if (parts.length !== 4) return false;
  const n = [];
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return false;
    const v = Number(p);
    if (v > 255) return false;
    n.push(v);
  }
  if (n[0] === 10) return true; // 10.0.0.0/8
  if (n[0] === 172 && n[1] >= 16 && n[1] <= 31) return true; // 172.16.0.0/12
  if (n[0] === 192 && n[1] === 168) return true; // 192.168.0.0/16
  if (n[0] === 127) return true; // 127.0.0.0/8
  if (n[0] === 169 && n[1] === 254) return true; // 169.254.0.0/16 link-local（含云元数据服务）
  if (n[0] === 0) return true; // 0.0.0.0/8
  return false;
}

// 把 IPv6 主机名展开为 8 个 16 位组；无法解析返回 null。
// 支持嵌入的点分 IPv4（如 ::ffff:1.2.3.4）。
function expandIPv6(h) {
  const v4m = h.match(/^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/);
  let s = h;
  if (v4m) {
    const parts = v4m[2].split('.').map(Number);
    if (parts.some((v) => v > 255)) return null;
    s =
      v4m[1] +
      ((parts[0] << 8) | parts[1]).toString(16) +
      ':' +
      ((parts[2] << 8) | parts[3]).toString(16);
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  if (head.length + tail.length > 8) return null;
  const groups = head.concat(new Array(8 - head.length - tail.length).fill('0'), tail);
  const nums = [];
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    nums.push(parseInt(g, 16));
  }
  return nums;
}

// 若是 IPv4 映射的 IPv6（::ffff:0:0/96，如 ::ffff:127.0.0.1 / ::ffff:7f00:1），
// 取出后 32 位转成点分 IPv4；否则返回 null。
function mappedIPv4(h) {
  const g = expandIPv6(h);
  if (!g) return null;
  if (g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0xffff) {
    return [(g[6] >> 8) & 0xff, g[6] & 0xff, (g[7] >> 8) & 0xff, g[7] & 0xff].join('.');
  }
  return null;
}

// 判断解析出的 IP 字符串是否为内网/特殊地址（v4 点分 / v6）。
// 供 DNS 解析结果检查用：域名可能指向内网 IP，光看主机名字符串不够。
function isPrivateIPString(ip) {
  const s = normHost(String(ip == null ? '' : ip));
  if (!s) return true;
  if (s.includes(':')) {
    const v4 = mappedIPv4(s);
    if (v4) return isPrivateIPv4(v4);
    const g = expandIPv6(s);
    if (!g) return true; // 解析不出视为可疑
    if (g.every((x) => x === 0)) return true; // ::/128 unspecified
    if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return true; // ::1/128 loopback
    if ((g[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
    if ((g[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
    return false;
  }
  return isPrivateIPv4(s);
}

// SSRF 防护：判断主机名是否为内网 / 回环 / 本地地址。
// 字面量 IP（含 IPv4 映射的 IPv6）在字符层面拦截；
// 普通域名返回 false，由 web_read 的 DNS 解析检查兜底。
function isPrivateHost(hostname) {
  const h = normHost(hostname);
  if (!h) return true; // 空主机名视为可疑，直接拦截
  if (h === 'localhost') return true;
  if (h.includes(':')) return isPrivateIPString(h); // IPv6 字面量（含 ::1）
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return isPrivateIPv4(h); // IPv4 字面量
  return false;
}

// 从 HTML 提取标题和正文：只取 body，去掉 script/style/nav/header/footer 块，
// 再去掉所有标签并压缩空白。
function extractArticle(html) {
  const src = String(html);
  let title = '';
  const tm = src.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (tm) title = cleanText(tm[1]);
  const bm = src.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  let body = bm ? bm[1] : src;
  body = body
    .replace(/<script[\s\S]*?<\/script\s*>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style\s*>/gi, ' ')
    .replace(/<(nav|header|footer)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<[^>]*>/g, ' ');
  const text = decodeEntities(body).replace(/\s+/g, ' ').trim();
  return { title, text };
}

// URL 安全检查：协议 + 主机名字符串快查 + DNS 解析结果检查。
// 成功返回 null；失败返回中文错误信息。供 web_read 对初始 URL 和重定向最终 URL 复用。
async function checkUrlSafety(u) {
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return '只支持 http/https 协议的网页';
  }
  if (isPrivateHost(u.hostname)) {
    return '拒绝访问内网或本地地址（SSRF 防护）';
  }
  // DNS 解析后检查：主机名可能是 evil.com → 127.0.0.1，或 0x7f.0.0.1 / 2130706433
  // 这类“非点分写法”的 IP，只看主机名字符串拦不住，必须看解析结果。
  // 注：lookup 与 fetch 之间存在 TOCTOU 窗口（DNS rebinding），v1 接受该残留风险。
  let addrs;
  try {
    addrs = await getDnsLookup()(u.hostname, { all: true });
  } catch (_) {
    return '域名解析失败';
  }
  if (!Array.isArray(addrs) || addrs.length === 0) {
    return '域名解析失败';
  }
  for (const a of addrs) {
    if (isPrivateIPString(a && a.address)) {
      return '拒绝访问内网或本地地址（SSRF 防护）';
    }
  }
  return null;
}

// 读取网页正文。成功返回 { title, text }，失败返回 { error }。
async function web_read(url, max_chars) {
  try {
    max_chars = Math.min(Math.max(parseInt(max_chars, 10) || 12000, 100), 200000);
    let u;
    try {
      u = new URL(String(url == null ? '' : url).trim());
    } catch (_) {
      return { error: '无效的 URL' };
    }
    const unsafe = await checkUrlSafety(u);
    if (unsafe) return { error: unsafe };
    let res;
    try {
      res = await fetchWithTimeout(
        u.toString(),
        { headers: { 'User-Agent': UA, Accept: 'text/html' } },
        timeoutMs()
      );
    } catch (e) {
      return { error: '读取网页' + netError(e) };
    }
    if (!res.ok) return { error: '网页返回 HTTP ' + res.status };
    // 跟随重定向后的最终地址也要再做一次完整 SSRF 检查，防止重定向绕过。
    try {
      const finalUrl = new URL(res.url || u.toString());
      const unsafeFinal = await checkUrlSafety(finalUrl);
      if (unsafeFinal) return { error: unsafeFinal };
    } catch (_) {
      return { error: '无效的重定向地址' };
    }
    const ct = (res.headers && res.headers.get('content-type')) || '';
    if (!/text\/html/i.test(ct)) return { error: '不支持的页面类型' };
    let html;
    try {
      html = await res.text();
    } catch (e) {
      return { error: '读取页面内容失败' };
    }
    const { title, text } = extractArticle(html);
    const clipped =
      text.length > max_chars ? text.slice(0, max_chars) + '\n…（正文过长，已截断）' : text;
    return { title, text: clipped };
  } catch (e) {
    return { error: '读取网页失败：' + (e && e.message ? e.message : String(e)) };
  }
}

// 把 web_search 的 results 数组格式化成喂给模型的纯文本。
function formatSearchResults(results) {
  if (!Array.isArray(results) || results.length === 0) return '（无搜索结果）';
  return results
    .map((r, i) => {
      const title = (r && r.title) || '（无标题）';
      const url = (r && r.url) || '';
      const snippet = (r && r.snippet) || '';
      let line = i + 1 + '. ' + title + '\n   ' + url;
      if (snippet) line += '\n   ' + snippet;
      return line;
    })
    .join('\n\n');
}

module.exports = { web_search, web_read, isPrivateHost, isPrivateIPString, formatSearchResults, setDnsLookup };
