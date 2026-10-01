# WEB 工具集成说明（给 coordinator）

Worker A 交付：`lib/web.js`（**新建文件**，未改动任何现有文件）。

模块导出：`web_search(query, count=8)`、`web_read(url, max_chars=12000)`、
`isPrivateHost(hostname)`、`formatSearchResults(results)`。
所有函数失败时返回 `{ error: '中文信息' }`，绝不抛错；密钥只从 `process.env.BRAVE_API_KEY` 读取。

---

## 1. WEB_TOOLS：追加到 `lib/agent.js` 的 `TOOLS` 数组

```js
{
  type: 'function',
  function: {
    name: 'web_search',
    description:
      '联网搜索外部信息。涉及时效性内容（新闻、版本发布、价格、CVE、API 变更）或不确定的外部事实时，先用它搜索再回答，禁止凭记忆编造。返回标题、链接和摘要列表。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索关键词' },
        count: { type: 'number', description: '返回条数，默认 8，最多 20' },
      },
      required: ['query'],
    },
  },
},
{
  type: 'function',
  function: {
    name: 'web_read',
    description:
      '读取公网网页正文，返回标题和正文文本。读全文前建议先用 web_search 看摘要确认相关性。只支持 http/https 公网页面，内网地址会被拒绝。',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '要读取的网页 URL' },
        max_chars: { type: 'number', description: '正文最大字符数，默认 12000' },
      },
      required: ['url'],
    },
  },
},
```

## 2. executeTool 映射（`lib/agent.js`）

文件顶部加：`const web = require('./web');`

在 `switch (name)` 中加两个分支。注意：这两个分支**不需要** `DATABASE_URL`
（不依赖云电脑），建议把 `DATABASE_URL` 检查下沉到 sandbox 相关分支，
或在检查前先处理 web 分支：

```js
case 'web_search': {
  const r = await web.web_search(args.query, args.count);
  if (r.error) return { ok: false, output: r.error };
  return { ok: true, output: truncate(web.formatSearchResults(r.results), TOOL_OUTPUT_LIMIT) };
}
case 'web_read': {
  const r = await web.web_read(args.url, args.max_chars);
  if (r.error) return { ok: false, output: r.error };
  return { ok: true, output: truncate('# ' + r.title + '\n\n' + r.text, TOOL_OUTPUT_LIMIT) };
}
```

`formatSearchResults(results)` 已在 `lib/web.js` 中实现并导出，
把 `[{title, url, snippet}]` 转成带序号的纯文本（空数组返回 `（无搜索结果）`）。

## 3. system prompt 追加文本（拼到 SYSTEM_PROMPT 后面）

```
涉及时效性信息（新闻、版本发布、价格、CVE、API 变更）或你不确定的外部事实时，
不要凭记忆编造，先调用 web_search 联网搜索再回答；引用事实时给出来源链接。
需要引用网页原文细节时再用 web_read 读取，读全文前先看搜索摘要判断相关性。
```

## 4. toolLabel 中文标签（`lib/agent.js` 的 `toolLabel` switch 中追加）

```js
case 'web_search':
  return '联网搜索：' + truncate(String(args.query || ''), 60).replace(/\n/g, ' ');
case 'web_read':
  return '读取网页：' + truncate(String(args.url || ''), 80).replace(/\n/g, ' ');
```

## 5. 环境变量（可选）

- `BRAVE_API_KEY`：设置后 `web_search` 改走 Brave Search API（`X-Subscription-Token`
  header），未设置则走 DuckDuckGo HTML 解析。密钥只从 env 读，不打日志。
- `WEB_FETCH_TIMEOUT_MS`：覆盖默认 15 秒请求超时（仅测试/调优用，默认不需要设）。

## 6. 验证

- `node --check lib/web.js` 通过
- `node test/web.test.js` → `web tests: N/N passed`，退出码 0
