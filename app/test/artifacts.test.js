// openmuse P1 Worker B — artifacts 纯 node + assert mock 测试。
// 运行：node test/artifacts.test.js
'use strict';

const assert = require('assert');
const artifacts = require('../lib/artifacts');
const { registerArtifactRoutes } = require('../lib/artifactRoutes');

let passed = 0;
let failed = 0;
const failures = [];

async function test(name, fn) {
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

// mock pool：记录每一次 SQL 与参数
function mockPool(impl) {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql, params });
      return impl ? impl(sql, params) : { rows: [], rowCount: 0 };
    },
  };
}

const fakeRow = {
  id: 'a1',
  user_id: 'u1',
  session_id: 's1',
  type: 'html',
  title: '测试',
  content: '<h1>hi</h1>',
};

function assertUserIdGuard(pool, label) {
  assert(pool.calls.length > 0, label + '：未执行任何 SQL');
  for (const c of pool.calls) {
    assert(c.sql.includes('user_id'), label + '：SQL 缺 user_id → ' + c.sql.slice(0, 80));
    assert(c.params.includes('u1'), label + '：参数缺 user_id 值 → ' + JSON.stringify(c.params));
  }
}

async function main() {
  console.log('artifacts tests:');

  // ---- createArtifact 校验 ----
  await test('createArtifact：非法 type 抛中文 Error', async () => {
    const pool = mockPool();
    artifacts.setPool(pool);
    await assert.rejects(
      () => artifacts.createArtifact({ userId: 'u1', title: 'x', type: 'pdf', content: 'c' }),
      (e) => e instanceof Error && /不支持的 artifact 类型/.test(e.message)
    );
  });

  await test('createArtifact：content 超 500KB 抛错', async () => {
    const pool = mockPool();
    artifacts.setPool(pool);
    await assert.rejects(
      () =>
        artifacts.createArtifact({
          userId: 'u1',
          title: 'x',
          type: 'html',
          content: 'x'.repeat(512001),
        }),
      (e) => e instanceof Error && /超过 500KB 上限/.test(e.message)
    );
  });

  await test('createArtifact：合法输入成功并返回整行（含 uuid id）', async () => {
    const pool = mockPool(() => ({ rows: [{ ...fakeRow }], rowCount: 1 }));
    artifacts.setPool(pool);
    const row = await artifacts.createArtifact({
      userId: 'u1',
      sessionId: 's1',
      title: '测试',
      type: 'html',
      content: '<h1>hi</h1>',
    });
    assert.strictEqual(row.title, '测试');
    assert.strictEqual(pool.calls[0].params[0].length, 36); // randomUUID
    assertUserIdGuard(pool, 'create');
  });

  // ---- getArtifact ----
  await test('getArtifact：SQL 带 user_id，查不到返回 null', async () => {
    const pool = mockPool(() => ({ rows: [], rowCount: 0 }));
    artifacts.setPool(pool);
    const row = await artifacts.getArtifact('u1', 'a1');
    assert.strictEqual(row, null);
    assertUserIdGuard(pool, 'get');
  });

  // ---- listArtifacts ----
  await test('listArtifacts：带/不带 session_id 都用 user_id 隔离', async () => {
    const pool = mockPool(() => ({ rows: [], rowCount: 0 }));
    artifacts.setPool(pool);
    await artifacts.listArtifacts('u1', 's1');
    await artifacts.listArtifacts('u1');
    assertUserIdGuard(pool, 'list');
    assert(pool.calls[0].params.includes('s1'), '带 session_id 的查询缺少 session 参数');
  });

  // ---- updateArtifact ----
  await test('updateArtifact：超 500KB 抛错', async () => {
    const pool = mockPool();
    artifacts.setPool(pool);
    await assert.rejects(
      () => artifacts.updateArtifact('u1', 'a1', 'y'.repeat(512001)),
      (e) => e instanceof Error && /超过 500KB 上限/.test(e.message)
    );
  });

  await test('updateArtifact：SQL 带 user_id 且更新 updated_at=now()', async () => {
    const pool = mockPool(() => ({ rows: [{ ...fakeRow }], rowCount: 1 }));
    artifacts.setPool(pool);
    const row = await artifacts.updateArtifact('u1', 'a1', 'new');
    assert(row && row.id === 'a1');
    assert(/updated_at\s*=\s*now\(\)/i.test(pool.calls[0].sql), 'SQL 未更新 updated_at=now()');
    assertUserIdGuard(pool, 'update');
  });

  await test('updateArtifact：查不到返回 null（404 语义）', async () => {
    const pool = mockPool(() => ({ rows: [], rowCount: 0 }));
    artifacts.setPool(pool);
    assert.strictEqual(await artifacts.updateArtifact('u1', 'nope', 'x'), null);
  });

  // ---- deleteArtifact ----
  await test('deleteArtifact：SQL 带 user_id，返回删除行数', async () => {
    const pool = mockPool(() => ({ rows: [], rowCount: 1 }));
    artifacts.setPool(pool);
    assert.strictEqual(await artifacts.deleteArtifact('u1', 'a1'), 1);
    assertUserIdGuard(pool, 'delete');
  });

  // ---- executor ----
  await test('executeCreateArtifact：成功返回 {ok, output, artifact}', async () => {
    const pool = mockPool(() => ({ rows: [{ ...fakeRow }], rowCount: 1 }));
    artifacts.setPool(pool);
    const r = await artifacts.executeCreateArtifact(
      { title: '测试', type: 'html', content: '<h1>hi</h1>' },
      { userId: 'u1', sessionId: 's1' }
    );
    assert.strictEqual(r.ok, true);
    assert(r.artifact && r.artifact.id === 'a1' && r.artifact.title === '测试' && r.artifact.type === 'html');
  });

  await test('executeCreateArtifact：异常转 {ok:false, output:"创建失败：…"}', async () => {
    const pool = mockPool();
    artifacts.setPool(pool);
    const r = await artifacts.executeCreateArtifact(
      { title: 'x', type: 'pdf', content: 'c' },
      { userId: 'u1' }
    );
    assert.strictEqual(r.ok, false);
    assert(r.output.startsWith('创建失败：'), 'output 格式不对：' + r.output);
    assert(!('artifact' in r), '失败时不应带 artifact 字段');
  });

  await test('executeUpdateArtifact：查不到返回 ok:false "更新失败：artifact 不存在"', async () => {
    const pool = mockPool(() => ({ rows: [], rowCount: 0 }));
    artifacts.setPool(pool);
    const r = await artifacts.executeUpdateArtifact({ id: 'nope', content: 'x' }, { userId: 'u1' });
    assert.strictEqual(r.ok, false);
    assert(/artifact 不存在/.test(r.output));
  });

  // ---- DDL ----
  await test('ARTIFACTS_DDL 包含 CREATE TABLE / INDEX IF NOT EXISTS', () => {
    assert(/CREATE TABLE IF NOT EXISTS artifacts/i.test(artifacts.ARTIFACTS_DDL), '缺 TABLE IF NOT EXISTS');
    assert(/CREATE INDEX IF NOT EXISTS/i.test(artifacts.ARTIFACTS_DDL), '缺 INDEX IF NOT EXISTS');
    assert(artifacts.ARTIFACTS_DDL.includes('user_id'), '缺 user_id 列');
  });

  // ---- ARTIFACT_TOOLS ----
  await test('ARTIFACT_TOOLS：两个 OpenAI function 定义，必填项正确', () => {
    const names = artifacts.ARTIFACT_TOOLS.map((t) => t.function.name);
    assert.deepStrictEqual(names, ['create_artifact', 'update_artifact']);
    const c = artifacts.ARTIFACT_TOOLS[0].function;
    const u = artifacts.ARTIFACT_TOOLS[1].function;
    assert.deepStrictEqual(c.parameters.required, ['title', 'type', 'content']);
    assert.deepStrictEqual(u.parameters.required, ['id', 'content']);
    assert(/创建|画布/.test(c.description), 'description 应为中文');
  });

  // ---- routes ----
  function fakeApp() {
    const routes = [];
    const app = {
      routes,
      get(path, ...fns) {
        routes.push({ method: 'GET', path, fns });
      },
      delete(path, ...fns) {
        routes.push({ method: 'DELETE', path, fns });
      },
    };
    return app;
  }
  function fakeRes() {
    return {
      statusCode: 200,
      body: null,
      status(n) {
        this.statusCode = n;
        return this;
      },
      json(o) {
        this.body = o;
        return this;
      },
    };
  }
  async function runChain(fns, req, res) {
    let nextCalled = false;
    for (const fn of fns) {
      let advanced = false;
      const next = () => {
        advanced = true;
      };
      const maybe = fn(req, res, next);
      if (maybe && maybe.then) await maybe;
      if (!advanced) return false; // 中间件终止了链
      nextCalled = true;
    }
    return nextCalled;
  }

  await test('registerArtifactRoutes：注册 3 条路由（list/get/delete）', () => {
    const pool = mockPool();
    const app = fakeApp();
    registerArtifactRoutes(app, { pool, requireUser: (req, res, next) => next() });
    const paths = app.routes.map((r) => r.method + ' ' + r.path);
    assert(paths.includes('GET /api/artifacts'), '缺 GET /api/artifacts');
    assert(paths.includes('GET /api/artifacts/:id'), '缺 GET /api/artifacts/:id');
    assert(paths.includes('DELETE /api/artifacts/:id'), '缺 DELETE /api/artifacts/:id');
  });

  await test('路由：401 passthrough（假 requireUser 拒绝时链中断）', async () => {
    const pool = mockPool(() => ({ rows: [], rowCount: 0 }));
    const app = fakeApp();
    const reject = (req, res, next) => res.status(401).json({ error: 'unauthorized' });
    registerArtifactRoutes(app, { pool, requireUser: reject });
    const route = app.routes.find((r) => r.method === 'GET' && r.path === '/api/artifacts/:id');
    const res = fakeRes();
    const completed = await runChain(route.fns, { userId: 'u1', params: { id: 'a1' }, query: {} }, res);
    assert.strictEqual(res.statusCode, 401, '应返回 401');
    assert.strictEqual(completed, false, 'requireUser 拒绝后不应继续执行后续 handler');
  });

  await test('GET /api/artifacts/:id：查不到返回 404 {error,message}', async () => {
    const pool = mockPool(() => ({ rows: [], rowCount: 0 }));
    const app = fakeApp();
    registerArtifactRoutes(app, { pool, requireUser: (req, res, next) => next() });
    const route = app.routes.find((r) => r.method === 'GET' && r.path === '/api/artifacts/:id');
    const res = fakeRes();
    await runChain(route.fns, { userId: 'u1', params: { id: 'nope' }, query: {} }, res);
    assert.strictEqual(res.statusCode, 404);
    assert.strictEqual(res.body.error, 'not_found');
    assert(typeof res.body.message === 'string' && res.body.message.length > 0, '应有中文 message');
  });

  await test('GET /api/artifacts/:id：查到返回整行', async () => {
    const pool = mockPool(() => ({ rows: [{ ...fakeRow }], rowCount: 1 }));
    const app = fakeApp();
    registerArtifactRoutes(app, { pool, requireUser: (req, res, next) => next() });
    const route = app.routes.find((r) => r.method === 'GET' && r.path === '/api/artifacts/:id');
    const res = fakeRes();
    await runChain(route.fns, { userId: 'u1', params: { id: 'a1' }, query: {} }, res);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.id, 'a1');
  });

  await test('DELETE /api/artifacts/:id：rowCount=0 返回 404', async () => {
    const pool = mockPool(() => ({ rows: [], rowCount: 0 }));
    const app = fakeApp();
    registerArtifactRoutes(app, { pool, requireUser: (req, res, next) => next() });
    const route = app.routes.find((r) => r.path === '/api/artifacts/:id' && r.method === 'DELETE');
    const res = fakeRes();
    await runChain(route.fns, { userId: 'u1', params: { id: 'nope' }, query: {} }, res);
    assert.strictEqual(res.statusCode, 404);
  });

  await test('路由：无 pool 时 503（requireDb 语义）', async () => {
    const app = fakeApp();
    registerArtifactRoutes(app, { pool: null, requireUser: (req, res, next) => next() });
    const route = app.routes.find((r) => r.method === 'GET' && r.path === '/api/artifacts');
    const res = fakeRes();
    const completed = await runChain(route.fns, { userId: 'u1', query: {} }, res);
    assert.strictEqual(res.statusCode, 503);
    assert.strictEqual(completed, false, 'requireDb 503 后不应继续执行');
  });

  console.log('');
  const total = passed + failed;
  console.log(`artifacts tests: ${passed}/${total} passed`);
  if (failed) {
    console.log('失败详情：');
    for (const f of failures) console.log(' - ' + f.name + ': ' + (f.err && f.err.message));
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('测试运行崩溃：', e);
  process.exit(1);
});
