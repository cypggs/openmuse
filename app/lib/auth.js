// openmuse 登录：better-auth (GitHub + Google OAuth)。
//
// 安全约定：
// - 所有密钥只从 process.env 读取（GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET /
//   GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / BETTER_AUTH_SECRET / BETTER_AUTH_URL），
//   绝不在代码、注释、日志或任何文件里写密钥值。
// - 某个 provider 的 env 缺失时，该 provider 不启用，但模块不崩溃。
// - 四个 OAuth 环境变量全齐才算真正启用登录；否则 server 走单用户开发模式
//  （req.userId = 'default'）。
'use strict';

const { betterAuth } = require('better-auth');
const { fromNodeHeaders } = require('better-auth/node');

let auth = null;
let providers = [];

/**
 * 用现有的 pg Pool 初始化 better-auth。没有 pool（无 DATABASE_URL）时
 * 返回 null，调用方走单用户开发模式。
 */
function initAuth(pool) {
  if (!pool) {
    console.warn('[openmuse] 登录未启用：DATABASE_URL 未配置，走单用户开发模式');
    return null;
  }
  const socialProviders = {};
  providers = [];

  const ghId = process.env.GITHUB_CLIENT_ID;
  const ghSecret = process.env.GITHUB_CLIENT_SECRET;
  if (ghId && ghSecret) {
    socialProviders.github = { clientId: ghId, clientSecret: ghSecret };
    providers.push('github');
  } else {
    console.warn('[openmuse] GitHub 登录未配置：缺少 GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET');
  }

  const gId = process.env.GOOGLE_CLIENT_ID;
  const gSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (gId && gSecret) {
    socialProviders.google = { clientId: gId, clientSecret: gSecret };
    providers.push('google');
  } else {
    console.warn('[openmuse] Google 登录未配置：缺少 GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET');
  }

  auth = betterAuth({
    appName: 'openmuse',
    // better-auth 本身也会读 BETTER_AUTH_SECRET / BETTER_AUTH_URL，这里显式传入以明确来源。
    secret: process.env.BETTER_AUTH_SECRET || undefined,
    baseURL: process.env.BETTER_AUTH_URL || 'http://localhost:3000',
    // 直接传 pg.Pool（better-auth 1.7.x 内置支持，无需 ORM 适配器）。
    database: pool,
    socialProviders,
    // OAuth token 落库前加密（AES-256-GCM）
    account: { encryptOAuthTokens: true },
  });

  if (isAuthEnabled()) {
    console.log('[openmuse] 登录已启用，providers:', providers.join(', '));
  } else {
    console.warn('[openmuse] 登录未完全启用（四个 OAuth 环境变量不全），走单用户开发模式');
  }
  return auth;
}

function getAuth() {
  return auth;
}

function authProviders() {
  return providers.slice();
}

// 四个 OAuth 环境变量全有（且 auth 已初始化）才为 true。
function isAuthEnabled() {
  return !!(
    auth &&
    process.env.GITHUB_CLIENT_ID &&
    process.env.GITHUB_CLIENT_SECRET &&
    process.env.GOOGLE_CLIENT_ID &&
    process.env.GOOGLE_CLIENT_SECRET
  );
}

module.exports = { initAuth, getAuth, isAuthEnabled, authProviders, requireUser };

/**
 * Express 中间件：启用登录时要求有效 session；未启用时走单用户开发模式。
 *
 * opts 可注入便于测试：
 *   - opts.isEnabled: () => bool（默认 isAuthEnabled）
 *   - opts.getSession: async (headers) => session|null（默认 auth.api.getSession）
 */
function requireUser(opts) {
  const o = opts || {};
  const enabled = o.isEnabled || isAuthEnabled;
  const getSession =
    o.getSession ||
    (async (headers) => {
      const a = getAuth();
      if (!a) return null;
      return a.api.getSession({ headers: fromNodeHeaders(headers) });
    });
  return async function requireUserMw(req, res, next) {
    if (!enabled()) {
      req.userId = 'default';
      return next();
    }
    try {
      const session = await getSession(req.headers);
      if (!session || !session.user) {
        return res.status(401).json({ error: 'unauthorized', message: '请先登录' });
      }
      req.userId = session.user.id;
      req.user = session.user;
      next();
    } catch (e) {
      console.error('[openmuse] getSession failed:', e.message);
      return res.status(401).json({ error: 'unauthorized', message: '请先登录' });
    }
  };
}
