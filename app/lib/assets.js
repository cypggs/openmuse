// 静态资源指纹：ver = 全部 .js 内容的 md5(8)，内容一变 URL 就变，
// 任何 CDN/浏览器缓存都不可能拿到旧文件（边缘层会强制改写 Cache-Control，
// 指纹是唯一可靠的缓存击穿手段）。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function assetVersion(staticDir) {
  const h = crypto.createHash('md5');
  for (const f of fs.readdirSync(staticDir).sort()) {
    if (f.endsWith('.js')) h.update(fs.readFileSync(path.join(staticDir, f)));
  }
  return h.digest('hex').slice(0, 8);
}

// 把 index.html 里的 __ASSET_VER__ 占位替换成真实指纹；
// 残留占位 = 发版后用户必拿旧 JS，直接抛错让部署失败 rather than 静默上线旧前端。
function renderIndexHtml(staticDir, ver) {
  const raw = fs.readFileSync(path.join(staticDir, 'index.html'), 'utf8');
  const out = raw.split('__ASSET_VER__').join(ver || assetVersion(staticDir));
  if (out.includes('__ASSET_VER__')) {
    throw new Error('index.html 仍有未替换的 __ASSET_VER__ 占位');
  }
  return out;
}

module.exports = { assetVersion, renderIndexHtml };
