// openmuse P0 审批机制测试：纯 node + assert，无测试框架。
// DB 用最小 fake pool；waitForDecision 走真实内存 pub/sub。
// 运行：node test/approvals.test.js
'use strict';

const assert = require('assert');
const approvals = require('../lib/approvals');

// ---------- 最小 fake pool ----------
function fakePool() {
  const state = {
    approvals: new Map(),
    grants: new Set(),
    audit: [],
  };
  const pool = {
    state,
    async query(sql, params) {
      const q = sql.replace(/\s+/g, ' ').trim();
      // INSERT INTO approvals ... RETURNING
      if (q.startsWith('INSERT INTO approvals')) {
        const [id, user_id, session_id, kind, title, detail, expires_at] = params;
        const row = {
          id, user_id, session_id, kind, title,
          detail: JSON.parse(detail),
          status: 'pending',
          created_at: new Date().toISOString(),
          expires_at,
        };
        state.approvals.set(id, row);
        return { rows: [{ ...row }] };
      }
      // SELECT * FROM approvals WHERE id = $1 AND user_id = $2
      if (q.startsWith('SELECT * FROM approvals WHERE id')) {
        const row = state.approvals.get(params[0]);
        if (row && row.user_id === params[1]) return { rows: [{ ...row }] };
        return { rows: [] };
      }
      // UPDATE approvals SET status
      if (q.startsWith('UPDATE approvals SET status')) {
        const row = state.approvals.get(params[1]);
        if (row) row.status = params[0];
        return { rows: [] };
      }
      // UPDATE ... expired RETURNING id
      if (q.includes("SET status = 'expired'") && q.includes('RETURNING id')) {
        const out = [];
        for (const row of state.approvals.values()) {
          if (row.user_id === params[0] && row.status === 'pending' &&
              new Date(row.expires_at) < new Date()) {
            row.status = 'expired';
            out.push({ id: row.id });
          }
        }
        return { rows: out };
      }
      // SELECT pending list
      if (q.startsWith('SELECT * FROM approvals WHERE user_id')) {
        const rows = [...state.approvals.values()]
          .filter((r) => r.user_id === params[0] && r.status === 'pending');
        return { rows: rows.map((r) => ({ ...r })) };
      }
      // INSERT INTO standing_grants
      if (q.startsWith('INSERT INTO standing_grants')) {
        state.grants.add(params[0] + '|' + params[1] + '|' + params[2]);
        return { rows: [] };
      }
      // SELECT grant check
      if (q.startsWith('SELECT 1 FROM standing_grants')) {
        const key = params[0] + '|' + params[1] + '|' + params[2];
        return { rows: state.grants.has(key) ? [{ '?column?': 1 }] : [] };
      }
      // INSERT INTO approval_audit
      if (q.startsWith('INSERT INTO approval_audit')) {
        state.audit.push({
          approval_id: params[0], user_id: params[1],
          kind: params[2], site: params[3], decision: params[4],
        });
        return { rows: [] };
      }
      throw new Error('fakePool 未覆盖: ' + q.slice(0, 60));
    },
  };
  return pool;
}

async function main() {
  const pool = fakePool();
  const uid = 'user-1';

  // 1. 创建审批：脱敏检查（password 字段被剥离）
  const a1 = await approvals.createApproval(pool, {
    userId: uid,
    kind: 'credential_fill',
    title: '登录请求',
    detail: { site: 'github.com', username: 'c***s', password: 'super-secret', action: '登录' },
  });
  assert.strictEqual(a1.status, 'pending', '新审批应为 pending');
  assert.ok(a1.id, '应有 id');
  assert.strictEqual(a1.detail.password, undefined, 'password 字段必须被剥离');
  assert.strictEqual(a1.detail.site, 'github.com', '普通字段保留');
  console.log('ok 1 - createApproval + sanitizeDetail');

  // 2. waitForDecision + decideApproval 联动
  const waitP = approvals.waitForDecision(a1.id, 5000);
  const res = await approvals.decideApproval(pool, {
    id: a1.id, userId: uid, decision: 'allow_once',
  });
  assert.strictEqual(res.decision, 'allow_once');
  const waited = await waitP;
  assert.strictEqual(waited, 'allow_once', '等待者应收到决定');
  console.log('ok 2 - waitForDecision/decideApproval 联动');

  // 3. 幂等：已决定的再次 decide 返回原状态
  const res2 = await approvals.decideApproval(pool, {
    id: a1.id, userId: uid, decision: 'deny',
  });
  assert.strictEqual(res2.already, true, '已决定应幂等返回');
  assert.strictEqual(res2.decision, 'approved', '状态不应被覆盖');
  console.log('ok 3 - decide 幂等');

  // 4. allow_always → standing_grants + checkGrant
  const a2 = await approvals.createApproval(pool, {
    userId: uid, kind: 'credential_fill', title: '登录',
    detail: { site: 'github.com', username: 'x' },
  });
  await approvals.decideApproval(pool, { id: a2.id, userId: uid, decision: 'allow_always' });
  const granted = await approvals.checkGrant(pool, {
    userId: uid, scopeKind: 'credential_fill', scopeValue: 'github.com',
  });
  assert.strictEqual(granted, true, 'allow_always 应写入 standing_grants');
  const notGranted = await approvals.checkGrant(pool, {
    userId: uid, scopeKind: 'credential_fill', scopeValue: 'other.com',
  });
  assert.strictEqual(notGranted, false, '其他站点不应命中');
  console.log('ok 4 - allow_always → standing_grants');

  // 5. 审计日志只记元数据
  assert.strictEqual(pool.state.audit.length, 2, '两次决定应有两条审计');
  const auditJson = JSON.stringify(pool.state.audit);
  assert.ok(!auditJson.includes('super-secret'), '审计日志不得含凭证值');
  assert.ok(auditJson.includes('github.com'), '审计应记录站点');
  console.log('ok 5 - approval_audit 脱敏');

  // 6. 非法 decision 抛错；不存在的审批 404 语义
  await assert.rejects(
    approvals.decideApproval(pool, { id: a2.id, userId: uid, decision: 'maybe' }),
    /decision 非法/
  );
  await assert.rejects(
    approvals.decideApproval(pool, { id: 'nope', userId: uid, decision: 'deny' }),
    /审批不存在/
  );
  console.log('ok 6 - 非法输入校验');

  // 7. 过期：ttlMs=1ms，等待后 decide 应返回 expired
  const a3 = await approvals.createApproval(pool, {
    userId: uid, kind: 'download', title: '下载', detail: {}, ttlMs: 1,
  });
  await new Promise((r) => setTimeout(r, 5));
  const r3 = await approvals.decideApproval(pool, { id: a3.id, userId: uid, decision: 'allow_once' });
  assert.strictEqual(r3.decision, 'expired', '过期审批决定应返回 expired');
  console.log('ok 7 - 过期处理');

  // 8. pendingApprovals 只返回 pending
  const pend = await approvals.pendingApprovals(pool, uid);
  assert.ok(pend.every((p) => p.status === 'pending'), '只应返回 pending');
  assert.ok(pend.every((p) => p.detail.password === undefined), '公开视图无敏感字段');
  console.log('ok 8 - pendingApprovals');

  // 9. publicView 白名单（无 user_id 等内部字段）
  const pv = approvals.publicView({
    id: 'x', user_id: 'u', session_id: 's', kind: 'k', title: 't',
    detail: '{}', status: 'pending', created_at: 'c', expires_at: 'e',
  });
  assert.strictEqual(pv.user_id, undefined, '公开视图不应暴露 user_id');
  assert.strictEqual(pv.session_id, undefined, '公开视图不应暴露 session_id');
  assert.strictEqual(pv.id, 'x');
  console.log('ok 9 - publicView 白名单');

  // 10. waitForDecision 超时 → expired
  const t0 = Date.now();
  const d = await approvals.waitForDecision('never-created', 100);
  assert.strictEqual(d, 'expired', '超时应按 expired 处理');
  assert.ok(Date.now() - t0 < 1000, '超时应及时返回');
  console.log('ok 10 - waitForDecision 超时');

  console.log('\n全部 10 项通过');
}

main().catch((e) => {
  console.error('FAIL:', e.message);
  process.exit(1);
});
