// openmuse v2.1 — per-user E2B sandbox manager (muse-style persistent sandbox).
//
// 三层持久化设计（E2B 原生优先）：
//  1. 原生 pause/resume：空闲 20min 后 pause()（保留完整内存快照）。paused 的
//     sandbox 不计费、不占并发、可 indefinite 停留；下次使用时
//     Sandbox.connect() 自动 resume（约 1s）。创建时带
//     lifecycle: { onTimeout: 'pause', autoResume: true }，超时也走 pause 而非 kill。
//  2. 原生 snapshot 检查点：每 50 次 tool 执行 createSnapshot() 一次，只保留最新
//     一个；sandbox 被彻底删除时可从 snapshot 重建。
//  3. S3 导出层（可移植性）：exportToS3/importFromS3 把工作区打包成 tar.gz 存到
//     S3 兼容存储，用于跨平台迁移 / 手动备份，不在热路径上。
//
// 参考：E2B 官方 persistence 文档（sandbox pause & resume / snapshots）。
// 注意：JS SDK 的 SandboxOpts 里没有顶层的 autoPause 字段（那是底层
// NewSandbox API schema 的字段），等价能力是 lifecycle.onTimeout。
//
// Secrets (E2B_API_KEY, DATABASE_URL, AWS_*) 只从 process.env 读，绝不打印。
'use strict';

const path = require('path');
const { Sandbox, SandboxNotFoundError, NotFoundError } = require('e2b');
const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');

const WORKDIR = '/home/user/openmuse-work';
const LIFETIME_MS = 3_600_000; // Hobby plan max sandbox lifetime: 1h
const IDLE_PAUSE_MS = 20 * 60_000; // idle 20min -> pause (paused 不计费、可 indefinite 停留)
const CHECKPOINT_EVERY = 50; // 每 50 次 tool 执行做一次原生 snapshot 检查点
const REAPER_INTERVAL_MS = 60_000;
const SNAP_PREFIX = 'sandbox-snapshots/'; // 仅 S3 导出层使用

const E2B_API_KEY = process.env.E2B_API_KEY || '';

const SANDBOX_README = `# openmuse 云电脑

这是你的专属云电脑工作区（/home/user/openmuse-work）。

- openmuse 在这里为你执行命令、运行代码、读写文件
- 空闲时自动 pause（内存和文件都保留），下次使用约 1 秒恢复
- 每 50 次操作自动做一次原生 snapshot 检查点，可从快照重建
- 你可以让 openmuse 在这里搭建项目、记笔记、跑脚本
`;

// ---------- pool (injected by server.js) ----------
let pool = null;
function setPool(p) {
  pool = p;
}

// ---------- in-memory live sandbox handles ----------
// userId -> { sbx, lastActiveAt, paused, busy, toolCount }
const live = new Map();
// 迁移锁：防止并发 getSandbox 在迁移时竞态（一个杀老 sandbox，另一个还在用）
const migrating = new Set();

function touch(userId) {
  const entry = live.get(userId);
  if (entry) {
    entry.lastActiveAt = Date.now();
    entry.paused = false;
  }
  if (pool) {
    pool
      .query('UPDATE user_sandboxes SET last_active_at = now() WHERE user_id = $1', [userId])
      .catch((e) => console.error('[openmuse] sandbox touch failed:', e.message));
  }
}

async function heartbeat(sbx) {
  try {
    await sbx.setTimeout(LIFETIME_MS);
  } catch (_) {
    // best effort; sandbox has its own lifetime / auto-pause anyway
  }
}

function isNotFoundError(e) {
  if (!e) return false;
  return (
    e.name === 'SandboxNotFoundError' ||
    e.name === 'NotFoundError' ||
    e instanceof SandboxNotFoundError ||
    e instanceof NotFoundError
  );
}

// JS SDK 等价于 autoPause 的写法：超时后 pause 而非 kill，流量可自动 resume。
function createOpts(userId) {
  return {
    // P1: 浏览器能力需要 desktop 模板（Chrome + Xvfb + noVNC）。
    // "每用户一台电脑"：用户的 sandbox 即 desktop，代码工具照常可用（Node 20）。
    template: DESKTOP_TEMPLATE,
    timeoutMs: LIFETIME_MS,
    metadata: { owner: 'openmuse', userId: String(userId) },
    lifecycle: { onTimeout: 'pause', autoResume: true },
  };
}

// P1: 当前使用的模板（老用户从默认模板迁移过来）
const DESKTOP_TEMPLATE = 'openmuse-desktop';

// ---------- path safety: everything stays under WORKDIR ----------
function safePath(p) {
  const rel = String(p || '');
  const full = path.posix.normalize(path.posix.join(WORKDIR, rel));
  if (full !== WORKDIR && !full.startsWith(WORKDIR + '/')) {
    throw new Error('路径不合法：只能读写工作目录 /home/user/openmuse-work 下的文件');
  }
  return full;
}

function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

// ---------- S3 导出层（可移植性，非热路径）----------
// 主路径已是 E2B 原生 pause/resume + snapshot；这组函数只用于跨平台迁移 / 手动备份。
function bucketName() {
  return process.env.BUCKET_NAME || '';
}

function s3Client() {
  return new S3Client({
    endpoint: process.env.AWS_ENDPOINT_URL_S3,
    region: process.env.AWS_REGION || 'us-east-1',
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID || '',
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || '',
    },
    forcePathStyle: true,
  });
}

async function exportToS3(userId) {
  const bucket = bucketName();
  if (!bucket) throw new Error('导出存储未配置（缺少 BUCKET_NAME 环境变量）');
  const sbx = await findExisting(userId);
  if (!sbx) throw new Error('没有可导出的云电脑（当前没有活跃的 sandbox）');
  const r = await sbx.commands.run(
    `mkdir -p ${WORKDIR} && tar czf /tmp/ws.tar.gz -C /home/user openmuse-work && base64 -w0 /tmp/ws.tar.gz`,
    { timeoutMs: 120_000 }
  );
  if (r.exitCode !== 0) {
    throw new Error('打包工作区失败：' + (r.stderr || '').slice(0, 200));
  }
  const buf = Buffer.from(r.stdout.trim(), 'base64');
  await s3Client().send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: SNAP_PREFIX + userId + '.tar.gz',
      Body: buf,
      ContentType: 'application/gzip',
    })
  );
  return { ok: true, bytes: buf.length };
}

async function importFromS3(userId, sbx) {
  const bucket = bucketName();
  if (!bucket) return false;
  let b64;
  try {
    const res = await s3Client().send(
      new GetObjectCommand({ Bucket: bucket, Key: SNAP_PREFIX + userId + '.tar.gz' })
    );
    b64 = await res.Body.transformToString();
  } catch (e) {
    if (e && (e.name === 'NoSuchKey' || (e.$metadata && e.$metadata.httpStatusCode === 404))) {
      return false;
    }
    throw e;
  }
  if (!b64) return false;
  await sbx.files.write('/tmp/ws.b64', b64);
  const r = await sbx.commands.run(
    'base64 -d /tmp/ws.b64 > /tmp/ws.tar.gz && tar xzf /tmp/ws.tar.gz -C /home/user && rm -f /tmp/ws.b64 /tmp/ws.tar.gz',
    { timeoutMs: 120_000 }
  );
  if (r.exitCode !== 0) {
    throw new Error('恢复导出包失败：' + (r.stderr || '').slice(0, 200));
  }
  return true;
}

// ---------- get-or-create ----------
// findExisting: 只找"能用的"（running，或 paused→connect 自动 resume），绝不新建。
async function findExisting(userId) {
  const entry = live.get(userId);
  if (entry) {
    try {
      if (await entry.sbx.isRunning()) return entry.sbx;
    } catch (_) {}
    // 没在跑——可能是 paused。connect() 会自动 resume paused 的 sandbox。
    try {
      const sbx = await Sandbox.connect(entry.sbx.sandboxId);
      entry.sbx = sbx;
      entry.paused = false;
      entry.lastActiveAt = Date.now();
      if (pool) {
        pool
          .query(`UPDATE user_sandboxes SET status = 'active', last_active_at = now() WHERE user_id = $1`, [
            userId,
          ])
          .catch((e) => console.error('[openmuse] mark active failed:', e.message));
      }
      return sbx;
    } catch (_) {}
    live.delete(userId);
  }
  if (!pool) return null;
  try {
    const r = await pool.query(
      'SELECT sandbox_id, status, template FROM user_sandboxes WHERE user_id = $1',
      [userId]
    );
    if (r.rowCount > 0 && r.rows[0].sandbox_id && (r.rows[0].status === 'active' || r.rows[0].status === 'paused')) {
      // P1 模板迁移：老用户还在默认模板（478MB），必须换成 desktop 模板（4G）
      const storedTemplate = r.rows[0].template || 'default';
      if (storedTemplate !== DESKTOP_TEMPLATE) {
        console.log(`[openmuse] migrating user=${userId} from template=${storedTemplate} to ${DESKTOP_TEMPLATE}`);
        try {
          // 尝试杀掉老 sandbox（避免资源浪费）；失败也不阻塞
          const oldSbx = await Sandbox.connect(r.rows[0].sandbox_id).catch(() => null);
          if (oldSbx) await oldSbx.kill().catch(() => {});
        } catch (_) {}
        // 清掉老记录，让 getSandbox 走全新创建
        await pool.query(`DELETE FROM user_sandboxes WHERE user_id = $1`, [userId]).catch(() => {});
        live.delete(userId);
        return null;
      }
      try {
        // connect 对 paused sandbox 自动 resume（约 1s）
        const sbx = await Sandbox.connect(r.rows[0].sandbox_id);
        live.set(userId, { sbx, lastActiveAt: Date.now(), paused: false, busy: false, toolCount: 0 });
        if (r.rows[0].status === 'paused') {
          await pool.query(`UPDATE user_sandboxes SET status = 'active' WHERE user_id = $1`, [userId]);
        }
        return sbx;
      } catch (e) {
        if (!isNotFoundError(e)) console.error('[openmuse] sandbox reconnect failed:', e.message);
        // NotFound → 掉到 getSandbox 的 snapshot 恢复路径
      }
    }
  } catch (e) {
    console.error('[openmuse] sandbox lookup failed:', e.message);
  }
  return null;
}

async function getSandbox(userId) {
  if (!E2B_API_KEY) throw new Error('E2B_API_KEY 未配置，云电脑不可用');
  // 迁移进行中时等待（避免竞态：一个在杀老 sandbox，另一个还在用）
  if (migrating.has(userId)) {
    console.log(`[openmuse] user=${userId} 迁移进行中，等待...`);
    for (let i = 0; i < 90; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      if (!migrating.has(userId)) break;
    }
  }
  const existing = await findExisting(userId);
  let needMigration = false;
  if (existing) {
    // 硬检查：确认是 desktop 模板（防 DB 记录与实际不符）
    // 老 478MB 模板没有 /opt/noVNC，必须迁移
    try {
      const chk = await existing.commands.run('test -d /opt/noVNC && echo DESKTOP || echo OLD', { timeoutMs: 10000 });
      if (chk.stdout.trim() !== 'DESKTOP') {
        console.log(`[openmuse] user=${userId} sandbox 不是 desktop 模板，强制迁移`);
        needMigration = true;
      } else {
        await heartbeat(existing);
        return existing;
      }
    } catch (e) {
      console.error('[openmuse] desktop check failed:', e.message);
      // 检查失败也返回 existing，避免误杀
      await heartbeat(existing);
      return existing;
    }
  }
  // 迁移或新建：加锁，整个过程（杀+建）独占
  if (needMigration) {
    if (migrating.has(userId)) {
      // 另一个请求已在迁移，等待它完成
      for (let i = 0; i < 90; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        if (!migrating.has(userId)) break;
      }
      const after = await findExisting(userId);
      if (after) {
        await heartbeat(after);
        return after;
      }
      // 掉到新建
    } else {
      migrating.add(userId);
      try {
        try { await existing.kill().catch(() => {}); } catch (_) {}
        live.delete(userId);
        if (pool) {
          await pool.query(`DELETE FROM user_sandboxes WHERE user_id = $1`, [userId]).catch(() => {});
        }
      } finally {
        // 注意：锁在新建完成后才释放（见下方）
      }
    }
  }

  let snapshotId = null;
  if (pool) {
    try {
      const r = await pool.query('SELECT snapshot_id FROM user_sandboxes WHERE user_id = $1', [userId]);
      if (r.rowCount > 0) snapshotId = r.rows[0].snapshot_id || null;
    } catch (e) {
      console.error('[openmuse] snapshot lookup failed:', e.message);
    }
  }

  let sbx = null;
  let how = 'fresh';
  // 1) 原生 snapshot 恢复（sandbox 被彻底删除时的救生索）
  if (snapshotId) {
    try {
      sbx = await Sandbox.create(snapshotId, createOpts(userId));
      how = 'snapshot';
    } catch (e) {
      console.error('[openmuse] create-from-snapshot failed (continuing fresh):', e.message);
      sbx = null;
    }
  }
  // 2) 全新创建
  if (!sbx) {
    sbx = await Sandbox.create(createOpts(userId));
    await sbx.commands.run(`mkdir -p ${WORKDIR}`);
    await sbx.files.write(WORKDIR + '/README.md', SANDBOX_README);
  }

  if (pool) {
    await pool.query(
      `INSERT INTO user_sandboxes (user_id, sandbox_id, status, last_active_at, template)
       VALUES ($1, $2, 'active', now(), $3)
       ON CONFLICT (user_id) DO UPDATE
       SET sandbox_id = $2, status = 'active', last_active_at = now(), template = $3`,
      [userId, sbx.sandboxId, DESKTOP_TEMPLATE]
    );
  }
  live.set(userId, { sbx, lastActiveAt: Date.now(), paused: false, busy: false, toolCount: 0 });
  // 迁移完成，释放锁
  migrating.delete(userId);
  await heartbeat(sbx);
  console.log(`[openmuse] sandbox ready for user=${userId} id=${sbx.sandboxId} via=${how}`);
  return sbx;
}

// ---------- 原生 snapshot 检查点 ----------
async function doCheckpoint(userId, sbx) {
  let prev = null;
  if (pool) {
    try {
      const r = await pool.query('SELECT snapshot_id FROM user_sandboxes WHERE user_id = $1', [userId]);
      if (r.rowCount > 0) prev = r.rows[0].snapshot_id || null;
    } catch (_) {}
  }
  const name = `openmuse-${String(userId).replace(/[^a-zA-Z0-9-]/g, '-')}-${Date.now()}`;
  const info = await sbx.createSnapshot({ name });
  if (pool) {
    await pool.query('UPDATE user_sandboxes SET snapshot_id = $1 WHERE user_id = $2', [
      info.snapshotId,
      userId,
    ]);
  }
  // 只保留最新一个检查点
  if (prev && prev !== info.snapshotId) {
    try {
      await Sandbox.deleteSnapshot(prev);
    } catch (e) {
      console.error('[openmuse] delete old snapshot failed (non-fatal):', e.message);
    }
  }
  console.log(`[openmuse] checkpoint ok user=${userId} snapshot=${info.snapshotId}`);
  return { ok: true, snapshotId: info.snapshotId };
}

async function maybeCheckpoint(userId, sbx) {
  const entry = live.get(userId);
  if (!entry) return;
  entry.toolCount = (entry.toolCount || 0) + 1;
  if (entry.toolCount < CHECKPOINT_EVERY) return;
  entry.toolCount = 0;
  try {
    await doCheckpoint(userId, sbx);
  } catch (e) {
    console.error('[openmuse] auto checkpoint failed (non-fatal):', e.message);
  }
}

// 手动原生 snapshot（不自动创建 sandbox）。
async function createCheckpoint(userId) {
  if (!E2B_API_KEY) throw new Error('E2B_API_KEY 未配置，云电脑不可用');
  const sbx = await findExisting(userId);
  if (!sbx) throw new Error('没有可快照的云电脑（当前没有活跃的 sandbox）');
  return doCheckpoint(userId, sbx);
}

// 手动 pause（默认保留完整内存快照）。
async function pauseSandbox(userId) {
  if (!E2B_API_KEY) throw new Error('E2B_API_KEY 未配置，云电脑不可用');
  const sbx = await findExisting(userId);
  if (!sbx) throw new Error('没有可暂停的云电脑（当前没有活跃的 sandbox）');
  const paused = await sbx.pause();
  const entry = live.get(userId);
  if (entry) entry.paused = true;
  if (pool) {
    await pool.query(`UPDATE user_sandboxes SET status = 'paused' WHERE user_id = $1`, [userId]);
  }
  return { ok: true, alreadyPaused: paused === false };
}

// ---------- tools ----------
async function execCommand(userId, command, timeoutMs = 60000) {
  const cmd = String(command || '').trim();
  if (!cmd) throw new Error('command 不能为空');
  const sbx = await getSandbox(userId);
  const entry = live.get(userId);
  if (entry) entry.busy = true;
  let result;
  try {
    try {
      result = await sbx.commands.run(cmd, { cwd: WORKDIR, timeoutMs });
    } catch (e) {
      // Some SDK versions surface non-zero exits as CommandExitError carrying .result
      if (e && e.result && typeof e.result.exitCode === 'number') {
        result = e.result;
      } else {
        throw e;
      }
    }
  } finally {
    if (entry) entry.busy = false;
  }
  touch(userId);
  await heartbeat(sbx);
  await maybeCheckpoint(userId, sbx);
  return {
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    exitCode: result.exitCode,
  };
}

async function readFile(userId, p) {
  const full = safePath(p); // validate before touching the sandbox
  const sbx = await getSandbox(userId);
  const entry = live.get(userId);
  if (entry) entry.busy = true;
  let text;
  try {
    text = await sbx.files.read(full);
  } finally {
    if (entry) entry.busy = false;
  }
  touch(userId);
  await heartbeat(sbx);
  await maybeCheckpoint(userId, sbx);
  return text;
}

async function writeFile(userId, p, content) {
  const full = safePath(p); // validate before touching the sandbox
  const sbx = await getSandbox(userId);
  const entry = live.get(userId);
  if (entry) entry.busy = true;
  try {
    const dir = path.posix.dirname(full);
    if (dir !== WORKDIR) {
      await sbx.commands.run(`mkdir -p ${shellQuote(dir)}`);
    }
    await sbx.files.write(full, String(content == null ? '' : content));
  } finally {
    if (entry) entry.busy = false;
  }
  touch(userId);
  await heartbeat(sbx);
  await maybeCheckpoint(userId, sbx);
  return { ok: true, path: full };
}

async function runPython(userId, code) {
  const src = String(code || '');
  if (!src.trim()) throw new Error('code 不能为空');
  const sbx = await getSandbox(userId);
  await sbx.files.write(WORKDIR + '/.tmp_run.py', src);
  const r = await execCommand(userId, 'python3 .tmp_run.py');
  return r;
}

async function getStatus(userId) {
  if (!E2B_API_KEY) return { status: 'unconfigured', sandboxId: null, lastActiveAt: null };
  const entry = live.get(userId);
  if (entry) {
    let running = false;
    try {
      running = await entry.sbx.isRunning();
    } catch (_) {}
    if (running) {
      return {
        status: 'active',
        sandboxId: entry.sbx.sandboxId,
        lastActiveAt: new Date(entry.lastActiveAt).toISOString(),
      };
    }
    if (entry.paused) {
      return {
        status: 'paused',
        sandboxId: entry.sbx.sandboxId,
        lastActiveAt: new Date(entry.lastActiveAt).toISOString(),
      };
    }
    live.delete(userId);
  }
  if (pool) {
    try {
      const r = await pool.query(
        'SELECT sandbox_id, status, last_active_at FROM user_sandboxes WHERE user_id = $1',
        [userId]
      );
      if (r.rowCount > 0) {
        const row = r.rows[0];
        // DB 是真相来源：'active' 但不在内存 map（进程重启过）→ 'idle'；
        // 'paused' 保持 'paused'，下次使用 connect 自动 resume。
        const st = row.status === 'active' ? 'idle' : row.status || 'none';
        return {
          status: st,
          sandboxId: row.sandbox_id,
          lastActiveAt: row.last_active_at ? new Date(row.last_active_at).toISOString() : null,
        };
      }
    } catch (e) {
      console.error('[openmuse] sandbox status lookup failed:', e.message);
    }
  }
  return { status: 'none', sandboxId: null, lastActiveAt: null };
}

// ---------- idle reaper: pause (not kill) ----------
// pause 保留完整内存快照；paused 不计费、不占并发、可 indefinite 停留。
// pause 失败则保留在 map，下分钟重试——绝不 kill，避免丢数据。
let reaperStarted = false;
function startReaper() {
  if (reaperStarted) return;
  reaperStarted = true;
  if (!E2B_API_KEY) {
    console.log('[openmuse] sandbox reaper disabled (E2B_API_KEY 未配置)');
    return;
  }
  setInterval(async () => {
    const now = Date.now();
    for (const [userId, entry] of live) {
      if (entry.paused || entry.busy) continue;
      if (now - entry.lastActiveAt < IDLE_PAUSE_MS) continue;
      try {
        await entry.sbx.pause(); // 默认 keepMemory：完整内存快照
        entry.paused = true;
        if (pool) {
          await pool.query(`UPDATE user_sandboxes SET status = 'paused' WHERE user_id = $1`, [userId]);
        }
        console.log(`[openmuse] sandbox paused after idle: user=${userId}`);
      } catch (e) {
        console.error(`[openmuse] idle pause failed for user=${userId}, retry next round:`, e.message);
      }
    }
  }, REAPER_INTERVAL_MS).unref();
  console.log('[openmuse] sandbox reaper started (idle 20min -> pause, keep memory)');
}

module.exports = {
  WORKDIR,
  setPool,
  startReaper,
  getSandbox,
  getStatus,
  execCommand,
  readFile,
  writeFile,
  runPython,
  createCheckpoint,
  pauseSandbox,
  exportToS3,
  importFromS3,
};
