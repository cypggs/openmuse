// openmuse P1 — scheduler 单元测试（纯 node + assert，无外部依赖）。
// 运行：node test/scheduler.test.js
// 用法：mock pool（内存数组按 SQL 关键字分发）+ monkey-patch agent.runAgent，事后恢复。
'use strict';

const assert = require('assert');
const scheduler = require('../lib/scheduler');
const agentMod = require('../lib/agent');

let passed = 0;
let total = 0;
async function t(name, fn) {
  total++;
  try {
    await fn();
    passed++;
  } catch (e) {
    console.error('FAIL:', name, '-', e && e.message);
  }
}

// ---------------------------------------------------------------------------
// mock pool：内存数组，按 SQL 关键字分发；支持 FOR UPDATE SKIP LOCKED 语义
// ---------------------------------------------------------------------------
function makeMockPool(tasks) {
  const seen = [];
  const lockedByOther = new Set(); // 模拟被其他实例锁定的行
  const nowIso = () => new Date().toISOString();

  const client = {
    query: async (sql, params) => {
      seen.push(sql);
      const s = String(sql).replace(/\s+/g, ' ');
      if (/^BEGIN$/i.test(s.trim())) return { rows: [] };
      if (/^COMMIT$/i.test(s.trim())) return { rows: [] };
      if (/^ROLLBACK$/i.test(s.trim())) return { rows: [] };
      if (/FROM tasks/i.test(s)) {
        // SELECT … FOR UPDATE SKIP LOCKED：跳过被其他实例锁定的行
        const now = Date.now();
        const due = tasks
          .filter(
            (x) =>
              x.status === 'active' &&
              !lockedByOther.has(x.id) &&
              new Date(x.next_run_at).getTime() <= now
          )
          .sort((a, b) => new Date(a.next_run_at) - new Date(b.next_run_at))
          .slice(0, 5);
        return { rows: due.map((x) => ({ ...x })) };
      }
      if (/UPDATE tasks SET status = \$1 WHERE id = \$2/i.test(s)) {
        const x = tasks.find((y) => y.id === params[0]);
        if (x) x.status = params[0];
        return { rowCount: x ? 1 : 0 };
      }
      throw new Error('mock client 收到未预期的 SQL: ' + sql);
    },
    release: () => {},
  };

  const poolMock = {
    seen,
    lock: (id) => lockedByOther.add(id),
    connect: async () => client,
    query: async (sql, params) => {
      seen.push(sql);
      const s = String(sql).replace(/\s+/g, ' ');
      if (/INSERT INTO tasks/i.test(s)) {
        const x = {
          id: params[0],
          user_id: params[1],
          kind: params[2],
          name: params[3],
          prompt: params[4],
          cron_expr: params[5],
          status: 'active',
          result: null,
          next_run_at: params[6] instanceof Date ? params[6].toISOString() : params[6],
          last_run_at: null,
          created_at: nowIso(),
        };
        tasks.push(x);
        return { rows: [{ ...x }] };
      }
      if (/UPDATE tasks SET status = \$1, result = \$2/i.test(s)) {
        const x = tasks.find((y) => y.id === params[3]);
        if (x) {
          x.status = params[0];
          x.result = params[1];
          x.last_run_at = nowIso();
          x.next_run_at = params[2] ? new Date(params[2]).toISOString() : null;
        }
        return { rowCount: x ? 1 : 0 };
      }
      throw new Error('mock pool 收到未预期的 SQL: ' + sql);
    },
  };
  return poolMock;
}

function pastTask(over) {
  return Object.assign(
    {
      id: 'task-' + Math.random().toString(36).slice(2, 8),
      user_id: 'u1',
      kind: 'once',
      name: '测试任务',
      prompt: '做点什么',
      cron_expr: null,
      status: 'active',
      result: null,
      next_run_at: new Date(Date.now() - 60000).toISOString(),
      last_run_at: null,
      created_at: new Date().toISOString(),
    },
    over || {}
  );
}

// monkey-patch agent.runAgent（事后恢复）
const origRunAgent = agentMod.runAgent;
let fakeFn = async () => ({ content: 'fake-ok' });
const fakeCalls = [];
agentMod.runAgent = async (args) => {
  fakeCalls.push(args);
  return fakeFn(args);
};
function resetFake() {
  fakeFn = async () => ({ content: 'fake-ok' });
  fakeCalls.length = 0;
}

(async () => {
  // ================= parseCron =================
  await t('parseCron: */15', () => {
    const c = scheduler.parseCron('*/15 * * * *');
    assert.deepStrictEqual([...c.minute].sort((a, b) => a - b), [0, 15, 30, 45]);
    assert.strictEqual(c.hour.size, 24);
    assert.strictEqual(c.dom.size, 31);
  });
  await t('parseCron: 范围 a-b', () => {
    const c = scheduler.parseCron('0 9-17 * * *');
    assert.deepStrictEqual([...c.hour].sort((a, b) => a - b), [9, 10, 11, 12, 13, 14, 15, 16, 17]);
  });
  await t('parseCron: 列表 a,b', () => {
    const c = scheduler.parseCron('0 0 1,15 * *');
    assert.deepStrictEqual([...c.dom].sort((a, b) => a - b), [1, 15]);
  });
  await t('parseCron: 范围+步长 a-b/n', () => {
    const c = scheduler.parseCron('0-30/10 * * * *');
    assert.deepStrictEqual([...c.minute].sort((a, b) => a - b), [0, 10, 20, 30]);
  });
  await t('parseCron: 周 7 视为 0', () => {
    const c = scheduler.parseCron('0 0 * * 7');
    assert.deepStrictEqual([...c.dow], [0]);
  });
  await t('parseCron: 非法抛错（超范围/字段数/步长/逆序）', () => {
    assert.throws(() => scheduler.parseCron('61 * * * *'), /超出范围/);
    assert.throws(() => scheduler.parseCron('* * * *'), /5 个字段/);
    assert.throws(() => scheduler.parseCron('*/0 * * * *'), /步长非法/);
    assert.throws(() => scheduler.parseCron('9-2 * * * *'), /超出范围/);
    assert.throws(() => scheduler.parseCron('abc * * * *'), /格式非法/);
    assert.throws(() => scheduler.parseCron('0 0 0 * *'), /超出范围/); // 日 0 非法
  });

  // ================= nextRun =================
  await t('nextRun: 0 9 * * * 从 10:00 起算出次日 9 点', () => {
    const n = scheduler.nextRun('0 9 * * *', new Date(2026, 9, 2, 10, 0, 0));
    assert.strictEqual(n.getFullYear(), 2026);
    assert.strictEqual(n.getMonth(), 9);
    assert.strictEqual(n.getDate(), 3);
    assert.strictEqual(n.getHours(), 9);
    assert.strictEqual(n.getMinutes(), 0);
  });
  await t('nextRun: 0 9 * * * 从 08:00 起算出当日 9 点', () => {
    const n = scheduler.nextRun('0 9 * * *', new Date(2026, 9, 2, 8, 0, 0));
    assert.strictEqual(n.getDate(), 2);
    assert.strictEqual(n.getHours(), 9);
  });
  await t('nextRun: */30 * * * * 从 10:05 起算出 10:30', () => {
    const n = scheduler.nextRun('*/30 * * * *', new Date(2026, 9, 2, 10, 5, 0));
    assert.strictEqual(n.getHours(), 10);
    assert.strictEqual(n.getMinutes(), 30);
  });
  await t('nextRun: dom/dow OR 语义（每月1日 或 周一 → 下一个是周一 10-05）', () => {
    // 2026-10-02 是周五；10-05 周一；11-01 周日（每月1日）
    const n = scheduler.nextRun('0 0 1 * 1', new Date(2026, 9, 2, 10, 0, 0));
    assert.strictEqual(n.getMonth(), 9);
    assert.strictEqual(n.getDate(), 5);
    assert.strictEqual(n.getDay(), 1);
    assert.strictEqual(n.getHours(), 0);
  });
  await t('nextRun: dom 单独受限（每月1日 → 11-01）', () => {
    const n = scheduler.nextRun('0 0 1 * *', new Date(2026, 9, 2, 10, 0, 0));
    assert.strictEqual(n.getMonth(), 10);
    assert.strictEqual(n.getDate(), 1);
  });
  await t('nextRun: dow 单独受限（每周一 → 10-05）', () => {
    const n = scheduler.nextRun('0 0 * * 1', new Date(2026, 9, 2, 10, 0, 0));
    assert.strictEqual(n.getMonth(), 9);
    assert.strictEqual(n.getDate(), 5);
    assert.strictEqual(n.getDay(), 1);
  });
  await t('nextRun: 非法表达式抛错', () => {
    assert.throws(() => scheduler.nextRun('61 * * * *', new Date()), /超出范围/);
  });

  // ================= tick：once 成功 → done =================
  await t('tick: once 成功 → done，结果落库', async () => {
    resetFake();
    const tasks = [pastTask()];
    const mock = makeMockPool(tasks);
    scheduler.setPool(mock);
    await scheduler.tick();
    assert.strictEqual(tasks[0].status, 'done');
    assert.strictEqual(tasks[0].result, 'fake-ok');
    assert.ok(tasks[0].last_run_at, 'last_run_at 应被更新');
    assert.strictEqual(tasks[0].next_run_at, null);
    // runAgent 调用形状：userId 透传、sessionId null、单条 user history、onEvent 函数
    assert.strictEqual(fakeCalls.length, 1);
    assert.strictEqual(fakeCalls[0].userId, 'u1');
    assert.strictEqual(fakeCalls[0].sessionId, null);
    assert.deepStrictEqual(fakeCalls[0].history, [{ role: 'user', content: '做点什么' }]);
    assert.strictEqual(typeof fakeCalls[0].onEvent, 'function');
  });

  // ================= tick：异常 → failed =================
  await t('tick: runAgent 抛错 → failed', async () => {
    resetFake();
    fakeFn = async () => {
      throw new Error('上游炸了');
    };
    const tasks = [pastTask()];
    scheduler.setPool(makeMockPool(tasks));
    await scheduler.tick();
    assert.strictEqual(tasks[0].status, 'failed');
    assert.ok(/任务执行失败/.test(tasks[0].result));
    assert.ok(/上游炸了/.test(tasks[0].result));
  });
  await t('tick: error 事件 → failed', async () => {
    resetFake();
    fakeFn = async (args) => {
      args.onEvent({ t: 'error', error: '模拟上游错误' });
      return { content: 'partial' };
    };
    const tasks = [pastTask()];
    scheduler.setPool(makeMockPool(tasks));
    await scheduler.tick();
    assert.strictEqual(tasks[0].status, 'failed');
    assert.ok(/模拟上游错误/.test(tasks[0].result));
  });
  await t('tick: content 为空 → failed', async () => {
    resetFake();
    fakeFn = async () => ({ content: '   ' });
    const tasks = [pastTask()];
    scheduler.setPool(makeMockPool(tasks));
    await scheduler.tick();
    assert.strictEqual(tasks[0].status, 'failed');
    assert.ok(/内容为空/.test(tasks[0].result));
  });

  // ================= tick：cron 重算 next_run_at =================
  await t('tick: cron 成功 → 回 active 且 next_run_at 重算到下个 9 点', async () => {
    resetFake();
    const tasks = [pastTask({ kind: 'cron', cron_expr: '0 9 * * *' })];
    scheduler.setPool(makeMockPool(tasks));
    await scheduler.tick();
    assert.strictEqual(tasks[0].status, 'active');
    assert.strictEqual(tasks[0].result, 'fake-ok');
    const nr = new Date(tasks[0].next_run_at);
    assert.ok(nr.getTime() > Date.now(), 'next_run_at 应在未来');
    assert.strictEqual(nr.getHours(), 9);
    assert.strictEqual(nr.getMinutes(), 0);
  });

  // ================= tick：SKIP LOCKED =================
  await t('tick: SQL 包含 FOR UPDATE SKIP LOCKED；被锁行被跳过', async () => {
    resetFake();
    const a = pastTask({ id: 'locked-a' });
    const b = pastTask({ id: 'free-b' });
    const tasks = [a, b];
    const mock = makeMockPool(tasks);
    mock.lock('locked-a'); // 模拟被其他实例锁定
    scheduler.setPool(mock);
    await scheduler.tick();
    assert.strictEqual(b.status, 'done', '未被锁定的任务应执行');
    assert.strictEqual(a.status, 'active', '被锁定的任务应被跳过');
    assert.ok(
      mock.seen.join('\n').includes('FOR UPDATE SKIP LOCKED'),
      'SELECT 必须带 FOR UPDATE SKIP LOCKED'
    );
  });

  // ================= tick：无 pool 直接返回 =================
  await t('tick: 无 pool 时静默返回不抛错', async () => {
    scheduler.setPool(null);
    await scheduler.tick();
  });

  // ================= createTask =================
  await t('createTask: once 立即到期；cron 算出 next_run_at 并校验表达式', async () => {
    resetFake();
    const tasks = [];
    scheduler.setPool(makeMockPool(tasks));
    const once = await scheduler.createTask({ userId: 'u9', name: '一次任务', prompt: 'hi', kind: 'once' });
    assert.strictEqual(once.status, 'active');
    assert.strictEqual(once.kind, 'once');
    assert.ok(new Date(once.next_run_at).getTime() <= Date.now() + 5000, 'once 应立即到期');
    const cron = await scheduler.createTask({
      userId: 'u9',
      name: '定时任务',
      prompt: 'hi',
      kind: 'cron',
      cron_expr: '0 9 * * *',
    });
    assert.strictEqual(cron.kind, 'cron');
    assert.strictEqual(new Date(cron.next_run_at).getHours(), 9);
  });
  await t('createTask: 校验失败抛中文错', async () => {
    scheduler.setPool(makeMockPool([]));
    await assert.rejects(
      scheduler.createTask({ userId: 'u', name: '', prompt: 'x' }),
      /名称/
    );
    await assert.rejects(
      scheduler.createTask({ userId: 'u', name: 'n', prompt: 'x', kind: 'weekly' }),
      /once 或 cron/
    );
    await assert.rejects(
      scheduler.createTask({ userId: 'u', name: 'n', prompt: 'x', kind: 'cron' }),
      /cron_expr/
    );
    await assert.rejects(
      scheduler.createTask({ userId: 'u', name: 'n', prompt: 'x', kind: 'cron', cron_expr: '61 * * * *' }),
      /超出范围/
    );
  });

  // ================= start/stop =================
  await t('startScheduler/stopScheduler 不抛错', async () => {
    resetFake();
    scheduler.setPool(makeMockPool([]));
    scheduler.startScheduler(null, { intervalMs: 60000 });
    scheduler.stopScheduler();
    scheduler.setPool(null);
  });

  // 恢复 monkey-patch
  agentMod.runAgent = origRunAgent;

  console.log(`scheduler tests: ${passed}/${total} passed`);
  process.exit(passed === total ? 0 : 1);
})().catch((e) => {
  agentMod.runAgent = origRunAgent;
  console.error('测试框架异常:', e);
  process.exit(1);
});
