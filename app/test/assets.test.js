// 静态资源指纹回归测试：发版后用户拿到旧 JS 曾导致一次误报（"部署没生效"），
// 指纹机制是修复手段，本文件锁住它。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { assetVersion, renderIndexHtml } = require('../lib/assets');

const STATIC_DIR = path.join(__dirname, '..', 'static');

test('assetVersion：8 位十六进制，且随 js 内容变化', () => {
  const v1 = assetVersion(STATIC_DIR);
  assert.match(v1, /^[0-9a-f]{8}$/);
  // 临时改一个 js 文件，版本必须变；恢复后必须回到原值
  const f = path.join(STATIC_DIR, 'toolsteps.js');
  const orig = fs.readFileSync(f);
  fs.writeFileSync(f, orig + '\n// probe');
  try {
    const v2 = assetVersion(STATIC_DIR);
    assert.notEqual(v2, v1, 'js 内容变了，指纹必须变');
  } finally {
    fs.writeFileSync(f, orig);
  }
  assert.equal(assetVersion(STATIC_DIR), v1, '恢复后指纹回到原值');
});

test('renderIndexHtml：占位全部替换，无残留', () => {
  const html = renderIndexHtml(STATIC_DIR, 'deadbeef');
  assert.ok(!html.includes('__ASSET_VER__'), '不能有残留占位');
  assert.ok(
    html.includes('/a/deadbeef/artifact-panel.js') &&
      html.includes('/a/deadbeef/task-panel.js') &&
      html.includes('/a/deadbeef/toolsteps.js'),
    '三个 script 应指向指纹 URL'
  );
});

test('renderIndexHtml：缺占位或 html 缺失时行为明确', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'assets-'));
  fs.writeFileSync(path.join(tmp, 'index.html'), '<html>no placeholder</html>');
  // 无占位也应正常返回（不抛错），调用方传 ver 即可
  const out = renderIndexHtml(tmp, 'abc12345');
  assert.ok(out.includes('no placeholder'));
  assert.throws(() => renderIndexHtml('/nonexistent-dir-xyz', 'abc12345'));
});
