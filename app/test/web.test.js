// openmuse 联网工具测试：纯 node + assert，无测试框架，不访问真实网络。
// 通过 global.fetch 打桩模拟各种响应。运行：node test/web.test.js
'use strict';

const assert = require('assert');

// 缩短超时，便于覆盖 AbortController 超时路径（默认 15000ms）。
process.env.WEB_FETCH_TIMEOUT_MS = '300';
const web = require('../lib/web');

// DNS 桩：默认所有域名解析到公网 IP，保证测试不做真实 DNS 查询。
// 个别用例可临时换桩（见“DNS 解析到内网”用例），用完恢复。
const PUBLIC_DNS = async () => [{ address: '93.184.216.34', family: 4 }];
web.setDnsLookup(PUBLIC_DNS);

const realFetch = global.fetch;
function stubFetch(fn) {
  global.fetch = fn;
}
function restoreFetch() {
  global.fetch = realFetch;
}

// 构造最小化的 fetch Response 桩。
function mkRes(opts) {
  const o = opts || {};
  return {
    ok: o.ok !== undefined ? o.ok : true,
    status: o.status || 200,
    url: o.url || '',
    headers: {
      get: (k) =>
        String(k).toLowerCase() === 'content-type'
          ? o.contentType !== undefined
            ? o.contentType
            : 'text/html; charset=utf-8'
          : null,
    },
    text: async () => (o.body !== undefined ? o.body : ''),
    json: async () => (o.jsonBody !== undefined ? o.jsonBody : {}),
  };
}

// 构造一个"永远挂起但响应 abort 信号"的 fetch 桩，用于测试超时。
function hangingFetch() {
  return (url, opts) =>
    new Promise((_, reject) => {
      const sig = opts && opts.signal;
      const onAbort = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      if (!sig) return; // 无 signal 时永远挂起（测试不会走到这里）
      if (sig.aborted) return onAbort();
      sig.addEventListener('abort', onAbort);
    });
}

const DDG_HTML = [
  '<html><body>',
  '<div class="result">',
  '<a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpage1&amp;rut=aaa">Example <b>Page</b> One</a>',
  '<a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpage1&amp;rut=aaa">  snippet   one  with   spaces </a>',
  '</div>',
  '<div class="result">',
  '<a class="result__a" rel="nofollow" href="//duckduckgo.com/l/?uddg=http%3A%2F%2Ftest.org%2Fa%3Fb%3D1&amp;rut=bbb">Second &amp; Title</a>',
  '<a class="result__snippet" href="//duckduckgo.com/l/?uddg=http%3A%2F%2Ftest.org%2Fa%3Fb%3D1&amp;rut=bbb">second snippet</a>',
  '</div>',
  '<div class="result">',
  '<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fthird.net%2F">Third</a>',
  '<a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fthird.net%2F">third snippet</a>',
  '</div>',
  '</body></html>',
].join('\n');

const PAGE_HTML = [
  '<html><head><title>Test &amp; Page</title><style>.a{color:red}</style></head>',
  '<body><header>hdr</header><nav>nav links here</nav>',
  '<script>var secret=1;</script>',
  '<main><h1>Hello</h1><p>world   foo</p></main>',
  '<footer>foot</footer></body></html>',
].join('\n');

let passed = 0;
let total = 0;
const failures = [];

async function t(name, fn) {
  total++;
  try {
    await fn();
    passed++;
    console.log('  ok - ' + name);
  } catch (e) {
    failures.push(name + ': ' + (e && e.message ? e.message : String(e)));
    console.log('  FAIL - ' + name);
  }
}

(async () => {
  // ---- web_search：DDG 路径 ----
  await t('DDG 解析：uddg 解码/标题去标签/snippet 压缩空白', async () => {
    let gotUrl = '';
    stubFetch(async (u) => {
      gotUrl = u;
      return mkRes({ body: DDG_HTML, url: u });
    });
    const r = await web.web_search('test query');
    assert.ok(!r.error, '不应返回 error，实际: ' + r.error);
    assert.ok(
      gotUrl === 'https://html.duckduckgo.com/html/?q=' + encodeURIComponent('test query'),
      '请求 URL 不对: ' + gotUrl
    );
    assert.strictEqual(r.results.length, 3);
    assert.strictEqual(r.results[0].title, 'Example Page One');
    assert.strictEqual(r.results[0].url, 'https://example.com/page1');
    assert.strictEqual(r.results[0].snippet, 'snippet one with spaces');
    assert.strictEqual(r.results[1].title, 'Second & Title');
    assert.strictEqual(r.results[1].url, 'http://test.org/a?b=1');
  });

  await t('DDG 解析：count 截断', async () => {
    stubFetch(async (u) => mkRes({ body: DDG_HTML, url: u }));
    const r = await web.web_search('x', 2);
    assert.ok(!r.error);
    assert.strictEqual(r.results.length, 2);
    assert.strictEqual(r.results[1].url, 'http://test.org/a?b=1');
  });

  await t('DDG 解析：空关键词返回 error', async () => {
    const r = await web.web_search('   ');
    assert.ok(r.error, '空关键词应返回 error');
  });

  await t('web_search 超时返回 {error} 且不抛错', async () => {
    stubFetch(hangingFetch());
    const r = await web.web_search('hang');
    assert.ok(r.error, '超时应返回 error');
    assert.ok(/超时/.test(r.error), '错误信息应提及超时: ' + r.error);
  });

  await t('web_search：fetch 直接抛错也不抛错', async () => {
    stubFetch(async () => {
      throw new Error('boom');
    });
    const r = await web.web_search('x');
    assert.ok(r.error, '应返回 error');
  });

  await t('web_search：非 200 返回 {error}', async () => {
    stubFetch(async (u) => mkRes({ ok: false, status: 503, url: u }));
    const r = await web.web_search('x');
    assert.ok(r.error && r.error.includes('503'), '错误信息应含状态码: ' + r.error);
  });

  // ---- web_search：Brave 路径 ----
  await t('BRAVE_API_KEY 存在时走 Brave API', async () => {
    process.env.BRAVE_API_KEY = 'test-key-123';
    let gotUrl = '';
    let gotHeaders = null;
    stubFetch(async (u, opts) => {
      gotUrl = u;
      gotHeaders = opts.headers;
      return mkRes({
        contentType: 'application/json',
        jsonBody: {
          results: [
            { title: 'Brave <b>T</b>', url: 'https://brave.example/x', description: 'desc  one' },
            { title: 'NoDesc', url: 'https://brave.example/y' },
          ],
        },
        url: u,
      });
    });
    try {
      const r = await web.web_search('brave q', 5);
      assert.ok(gotUrl.startsWith('https://api.search.brave.com/res/v1/web/search'), gotUrl);
      assert.ok(gotUrl.includes('q=' + encodeURIComponent('brave q')), gotUrl);
      assert.ok(gotUrl.includes('count=5'), gotUrl);
      assert.strictEqual(gotHeaders['X-Subscription-Token'], 'test-key-123');
      assert.ok(!r.error, r.error);
      assert.strictEqual(r.results.length, 2);
      assert.strictEqual(r.results[0].title, 'Brave T');
      assert.strictEqual(r.results[0].url, 'https://brave.example/x');
      assert.strictEqual(r.results[0].snippet, 'desc one');
      assert.strictEqual(r.results[1].snippet, '');
    } finally {
      delete process.env.BRAVE_API_KEY;
    }
  });

  await t('Brave API 非 200 返回 {error}', async () => {
    process.env.BRAVE_API_KEY = 'bad-key';
    stubFetch(async (u) => mkRes({ ok: false, status: 401, contentType: 'application/json', url: u }));
    try {
      const r = await web.web_search('x');
      assert.ok(r.error && r.error.includes('401'), r.error);
    } finally {
      delete process.env.BRAVE_API_KEY;
    }
  });

  // ---- isPrivateHost ----
  await t('isPrivateHost：内网/回环/本地拦截，公网放行', async () => {
    const yes = [
      '127.0.0.1', '127.0.0.2', '10.1.2.3', '10.255.255.255',
      '172.16.5.4', '172.31.0.1', '192.168.1.1', '192.168.0.254',
      'localhost', 'LOCALHOST', 'localhost.', '::1', '[::1]',
      '::ffff:127.0.0.1', '::ffff:7f00:1', '::FFFF:10.0.0.5', '[::ffff:192.168.1.1]', '::ffff:c0a8:101',
    ];
    for (const h of yes) {
      assert.strictEqual(web.isPrivateHost(h), true, h + ' 应被判定为内网');
    }
    const no = ['8.8.8.8', '1.1.1.1', '172.15.0.1', '172.32.0.1', '192.167.1.1', 'example.com', '2001:db8::1'];
    for (const h of no) {
      assert.strictEqual(web.isPrivateHost(h), false, h + ' 应被判定为公网');
    }
  });

  // ---- web_read：SSRF ----
  await t('web_read：SSRF 拦截且不发起请求', async () => {
    const blocked = [
      'http://127.0.0.1/', 'http://10.1.2.3/x', 'http://172.16.5.4/',
      'http://192.168.1.1:8080/', 'http://localhost/', 'http://LOCALHOST/',
      'http://[::1]/', 'https://[::1]/', 'http://[::ffff:127.0.0.1]/',
    ];
    for (const u of blocked) {
      let called = false;
      stubFetch(async () => {
        called = true;
        return mkRes({});
      });
      const r = await web.web_read(u);
      assert.ok(r.error && /内网|本地|SSRF/.test(r.error), u + ' 应被拦截，实际: ' + JSON.stringify(r));
      assert.ok(!called, u + ' 不应发起网络请求');
    }
  });

  await t('web_read：DNS 解析到内网 IP 也拦截（防域名指向内网）', async () => {
    web.setDnsLookup(async () => [{ address: '127.0.0.1', family: 4 }]);
    try {
      let called = false;
      stubFetch(async () => {
        called = true;
        return mkRes({});
      });
      const r = await web.web_read('https://evil.example.com/secret');
      assert.ok(r.error && /内网|本地|SSRF/.test(r.error), '应被拦截，实际: ' + JSON.stringify(r));
      assert.ok(!called, '不应发起网络请求');
    } finally {
      web.setDnsLookup(PUBLIC_DNS);
    }
  });

  await t('web_read：169.254.169.254（云元数据）拦截', async () => {
    let called = false;
    stubFetch(async () => {
      called = true;
      return mkRes({});
    });
    const r = await web.web_read('http://169.254.169.254/latest/meta-data/');
    assert.ok(r.error && /内网|本地|SSRF/.test(r.error), '应被拦截，实际: ' + JSON.stringify(r));
    assert.ok(!called, '不应发起网络请求');
  });

  await t('isPrivateIPString：v6 特殊地址判定', async () => {
    for (const h of ['::1', 'fe80::1', 'FE80::abcd', 'fc00::1', 'fd12:3456::1', '::', '::ffff:10.0.0.1']) {
      assert.strictEqual(web.isPrivateIPString(h), true, h + ' 应被判定为内网');
    }
    for (const h of ['2001:db8::1', '2606:4700:4700::1111', '8.8.8.8', '1.2.3.4']) {
      assert.strictEqual(web.isPrivateIPString(h), false, h + ' 应被判定为公网');
    }
  });

  await t('web_read：非 http(s) 协议拒绝', async () => {
    let called = false;
    stubFetch(async () => {
      called = true;
      return mkRes({});
    });
    for (const u of ['ftp://example.com/x', 'file:///etc/passwd', 'javascript:alert(1)', 'notaurl']) {
      const r = await web.web_read(u);
      assert.ok(r.error, u + ' 应返回 error');
      assert.ok(!called, u + ' 不应发起网络请求');
    }
  });

  await t('web_read：非 text/html 拒绝', async () => {
    stubFetch(async (u) => mkRes({ contentType: 'application/json', body: '{}', url: u }));
    const r = await web.web_read('https://example.com/api');
    assert.ok(r.error, '应返回 error');
    assert.ok(r.error.includes('不支持的页面类型'), r.error);
  });

  await t('web_read：去掉 script/style/nav/header/footer，提取标题正文', async () => {
    stubFetch(async (u) => mkRes({ body: PAGE_HTML, url: u }));
    const r = await web.web_read('https://example.com/p');
    assert.ok(!r.error, r.error);
    assert.strictEqual(r.title, 'Test & Page');
    assert.ok(!r.text.includes('secret'), 'script 内容应被去掉');
    assert.ok(!r.text.includes('color:red'), 'style 内容应被去掉');
    assert.ok(!r.text.includes('nav links here'), 'nav 内容应被去掉');
    assert.ok(!r.text.includes('hdr'), 'header 内容应被去掉');
    assert.ok(!r.text.includes('foot'), 'footer 内容应被去掉');
    assert.ok(r.text.includes('Hello'), '正文应保留');
    assert.ok(r.text.includes('world foo'), '空白应被压缩');
  });

  await t('web_read：max_chars 截断', async () => {
    const long = 'x'.repeat(5000);
    stubFetch(async (u) =>
      mkRes({ body: '<html><head><title>t</title></head><body><p>' + long + '</p></body></html>', url: u })
    );
    const r = await web.web_read('https://example.com/long', 100);
    assert.ok(!r.error, r.error);
    assert.ok(r.text.length <= 100 + 30, '截断后长度超限: ' + r.text.length);
    assert.ok(/截断/.test(r.text), '应有截断标记');
  });

  await t('web_read：重定向到内网地址被拦截', async () => {
    stubFetch(async () => mkRes({ body: '<html></html>', url: 'http://127.0.0.1/evil' }));
    const r = await web.web_read('https://example.com/go');
    assert.ok(r.error && /内网|本地|SSRF/.test(r.error), '重定向到内网应被拦截: ' + JSON.stringify(r));
  });

  await t('web_read 超时返回 {error} 且不抛错', async () => {
    stubFetch(hangingFetch());
    const r = await web.web_read('https://example.com/slow');
    assert.ok(r.error, '超时应返回 error');
  });

  // ---- formatSearchResults ----
  await t('formatSearchResults：格式化文本', async () => {
    const s = web.formatSearchResults([
      { title: 'A', url: 'https://a.com', snippet: 'sa' },
      { title: 'B', url: 'https://b.com', snippet: '' },
    ]);
    assert.ok(s.includes('1. A'));
    assert.ok(s.includes('https://a.com'));
    assert.ok(s.includes('sa'));
    assert.ok(s.includes('2. B'));
    assert.strictEqual(web.formatSearchResults([]), '（无搜索结果）');
    assert.strictEqual(web.formatSearchResults(null), '（无搜索结果）');
  });

  restoreFetch();
  delete process.env.WEB_FETCH_TIMEOUT_MS;

  console.log(`web tests: ${passed}/${total} passed`);
  if (failures.length) {
    console.log('failures:');
    for (const f of failures) console.log('  - ' + f);
  }
  process.exit(passed === total ? 0 : 1);
})().catch((e) => {
  console.error('test harness crashed:', e);
  process.exit(1);
});
