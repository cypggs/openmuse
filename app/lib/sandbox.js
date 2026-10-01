// openmuse v2 — per-user E2B sandbox manager (muse-style persistent sandbox).
//
// Design: one long-lived E2B sandbox per user. get-or-create on demand,
// heartbeat (setTimeout) after each tool use, idle reaper snapshots the
// workspace to S3 and kills the sandbox; next use restores from snapshot.
//
// Secrets (E2B_API_KEY, DATABASE_URL, AWS_*) are read only from
// process.env and are never logged or written anywhere.
'use strict';

const path = require('path');
const { Sandbox } = require('e2b');
const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');

const WORKDIR = '/home/user/openmuse-work';
const LIFETIME_MS = 3_600_000; // Hobby plan max sandbox lifetime: 1h
const IDLE_KILL_MS = 20 * 60_000; // snapshot + kill after 20 min idle
const SNAP_PREFIX = 'sandbox-snapshots/';
const REAPER_INTERVAL_MS = 60_000;

const E2B_API_KEY = process.env.E2B_API_KEY || '';

const SANDBOX_README = `# openmuse 云电脑

这是你的专属云电脑工作区（/home/user/openmuse-work）。

- openmuse 在这里为你执行命令、运行代码、读写文件
- 这里的文件会持久保存：空闲时自动快照，下次使用时恢复
- 你可以让 openmuse 在这里搭建项目、记笔记、跑脚本
`;

// ---------- pool (injected by server.js) ----------
let pool = null;
function setPool(p) {
  pool = p;
}

// ---------- in-memory live sandbox handles ----------
const live = new Map(); // userId -> { sbx, lastActiveAt }

function touch(userId) {
  const entry = live.get(userId);
  if (entry) entry.lastActiveAt = Date.now();
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
    // best effort; sandbox has its own lifetime anyway
  }
}

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

// ---------- S3 snapshot store ----------
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

async function snapshotToS3(userId, sbx) {
  const bucket = bucketName();
  if (!bucket) throw new Error('快照存储未配置（缺少 BUCKET_NAME 环境变量）');
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

async function restoreFromSnapshot(sbx, userId) {
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
    throw new Error('恢复快照失败：' + (r.stderr || '').slice(0, 200));
  }
  return true;
}

// ---------- get-or-create (never auto-creates in findExisting) ----------
async function connectIfAlive(sandboxId) {
  try {
    const sbx = await Sandbox.connect(sandboxId);
    if (await sbx.isRunning()) return sbx;
  } catch (_) {
    // dead or gone — caller creates a fresh one
  }
  return null;
}

async function findExisting(userId) {
  const entry = live.get(userId);
  if (entry) {
    try {
      if (await entry.sbx.isRunning()) return entry.sbx;
    } catch (_) {}
    live.delete(userId);
  }
  if (!pool) return null;
  try {
    const r = await pool.query('SELECT sandbox_id, status FROM user_sandboxes WHERE user_id = $1', [
      userId,
    ]);
    if (r.rowCount > 0 && r.rows[0].status === 'active' && r.rows[0].sandbox_id) {
      const sbx = await connectIfAlive(r.rows[0].sandbox_id);
      if (sbx) {
        live.set(userId, { sbx, lastActiveAt: Date.now() });
        return sbx;
      }
    }
  } catch (e) {
    console.error('[openmuse] sandbox lookup failed:', e.message);
  }
  return null;
}

async function getSandbox(userId) {
  if (!E2B_API_KEY) throw new Error('E2B_API_KEY 未配置，云电脑不可用');
  const existing = await findExisting(userId);
  if (existing) {
    await heartbeat(existing);
    return existing;
  }
  const sbx = await Sandbox.create({
    timeoutMs: LIFETIME_MS,
    metadata: { owner: 'openmuse', userId: String(userId) },
  });
  let restored = false;
  try {
    restored = await restoreFromSnapshot(sbx, userId);
  } catch (e) {
    console.error('[openmuse] snapshot restore failed (continuing fresh):', e.message);
  }
  if (!restored) {
    await sbx.commands.run(`mkdir -p ${WORKDIR}`);
    await sbx.files.write(WORKDIR + '/README.md', SANDBOX_README);
  }
  if (pool) {
    await pool.query(
      `INSERT INTO user_sandboxes (user_id, sandbox_id, status, last_active_at)
       VALUES ($1, $2, 'active', now())
       ON CONFLICT (user_id) DO UPDATE
       SET sandbox_id = $2, status = 'active', last_active_at = now()`,
      [userId, sbx.sandboxId]
    );
  }
  live.set(userId, { sbx, lastActiveAt: Date.now() });
  await heartbeat(sbx);
  console.log(`[openmuse] sandbox ready for user=${userId} id=${sbx.sandboxId} restored=${restored}`);
  return sbx;
}

// ---------- tools ----------
async function execCommand(userId, command, timeoutMs = 60000) {
  const cmd = String(command || '').trim();
  if (!cmd) throw new Error('command 不能为空');
  const sbx = await getSandbox(userId);
  let result;
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
  touch(userId);
  await heartbeat(sbx);
  return {
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    exitCode: result.exitCode,
  };
}

async function readFile(userId, p) {
  const full = safePath(p); // validate before touching the sandbox
  const sbx = await getSandbox(userId);
  const text = await sbx.files.read(full);
  touch(userId);
  await heartbeat(sbx);
  return text;
}

async function writeFile(userId, p, content) {
  const full = safePath(p); // validate before touching the sandbox
  const sbx = await getSandbox(userId);
  const dir = path.posix.dirname(full);
  if (dir !== WORKDIR) {
    await sbx.commands.run(`mkdir -p ${shellQuote(dir)}`);
  }
  await sbx.files.write(full, String(content == null ? '' : content));
  touch(userId);
  await heartbeat(sbx);
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

// Manual snapshot (does not create a sandbox if none exists).
async function snapshot(userId) {
  if (!E2B_API_KEY) throw new Error('E2B_API_KEY 未配置，云电脑不可用');
  const sbx = await findExisting(userId);
  if (!sbx) throw new Error('没有可快照的云电脑（当前没有活跃的 sandbox）');
  return snapshotToS3(userId, sbx);
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
        return {
          status: row.status === 'active' ? 'idle' : 'suspended',
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

// ---------- idle reaper: snapshot -> kill -> mark suspended ----------
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
      if (now - entry.lastActiveAt < IDLE_KILL_MS) continue;
      let snapshotted = false;
      try {
        await snapshotToS3(userId, entry.sbx);
        snapshotted = true;
      } catch (e) {
        // Don't kill if we couldn't persist the workspace; retry next round.
        console.error(`[openmuse] idle snapshot failed for user=${userId}:`, e.message);
        continue;
      }
      if (snapshotted) {
        try {
          await entry.sbx.kill();
        } catch (e) {
          console.error(`[openmuse] idle kill failed for user=${userId}:`, e.message);
        }
        live.delete(userId);
        if (pool) {
          try {
            await pool.query(`UPDATE user_sandboxes SET status = 'suspended' WHERE user_id = $1`, [
              userId,
            ]);
          } catch (e) {
            console.error('[openmuse] mark suspended failed:', e.message);
          }
        }
        console.log(`[openmuse] sandbox suspended after idle: user=${userId}`);
      }
    }
  }, REAPER_INTERVAL_MS).unref();
  console.log('[openmuse] sandbox reaper started (idle 20min -> snapshot + kill)');
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
  snapshot,
};
