// openmuse P1-3（工具摘要与步骤流）+ P1-4（SYSTEM_PROMPT 身份手术）测试。
// 纯 node + assert，无测试框架，不访问网络。运行：node test/toolsteps.test.js
'use strict';

const assert = require('assert');
const agent = require('../lib/agent');
const { toolSummary, SYSTEM_PROMPT } = agent;

/* ---------- toolSummary 各分支 ---------- */

// web_search：正常多结果
assert.strictEqual(
  toolSummary('web_search', { query: 'DeepSeek' },
    { ok: true, output: '1. A\n   http://a\n\n2. B\n   http://b\n\n3. C\n   http://c' }),
  '找到 3 条结果',
  'web_search 3 条结果'
);
// web_search：空结果边界
assert.strictEqual(
  toolSummary('web_search', { query: 'xyz' }, { ok: true, output: '（无搜索结果）' }),
  '找到 0 条结果',
  'web_search 空结果'
);
// web_search：执行失败边界
assert.strictEqual(
  toolSummary('web_search', { query: 'x' }, { ok: false, output: '联网工具执行失败：timeout' }),
  '搜索失败',
  'web_search 失败'
);

// web_read：正常标题
assert.strictEqual(
  toolSummary('web_read', { url: 'http://x' }, { ok: true, output: '# DeepSeek V4 发布\n\n正文…' }),
  '已读取《DeepSeek V4 发布》',
  'web_read 标题'
);
// web_read：标题截断 30 字边界
const longTitle = '一'.repeat(40);
assert.strictEqual(
  toolSummary('web_read', { url: 'http://x' }, { ok: true, output: '# ' + longTitle + '\n\n正文' }),
  '已读取《' + '一'.repeat(30) + '…》',
  'web_read 长标题截断'
);
// web_read：无标题边界
assert.strictEqual(
  toolSummary('web_read', { url: 'http://x' }, { ok: true, output: '纯正文没有标题行' }),
  '已读取网页',
  'web_read 无标题'
);
// web_read：失败边界
assert.strictEqual(
  toolSummary('web_read', { url: 'http://x' }, { ok: false, output: 'SSRF 拦截' }),
  '读取失败',
  'web_read 失败'
);

// sandbox_exec：成功 / 失败
assert.strictEqual(toolSummary('sandbox_exec', { command: 'ls' }, { ok: true, output: 'a\nb' }), '执行完成');
assert.strictEqual(toolSummary('sandbox_exec', { command: 'bad' }, { ok: false, output: 'err' }), '执行失败');

// create_artifact / update_artifact：有标题 / 无标题边界
assert.strictEqual(
  toolSummary('create_artifact', { title: 'Q3 报告' }, { ok: true, output: 'ok' }),
  '已创建画布：Q3 报告'
);
assert.strictEqual(
  toolSummary('create_artifact', {}, { ok: true, output: 'ok' }),
  '已创建画布',
  'create_artifact 无标题边界'
);
assert.strictEqual(
  toolSummary('update_artifact', { id: '1' }, { ok: true, output: 'ok' }),
  '已更新画布',
  'update_artifact 无标题边界'
);

// 其余工具返回空字符串
assert.strictEqual(toolSummary('sandbox_run_python', { code: '1+1' }, { ok: true, output: '2' }), '');
assert.strictEqual(toolSummary('sandbox_read_file', { path: 'a.txt' }, { ok: true, output: 'x' }), '');
assert.strictEqual(toolSummary('sandbox_write_file', { path: 'a.txt' }, { ok: true, output: 'ok' }), '');
assert.strictEqual(toolSummary('unknown_tool', {}, { ok: false, output: '未知工具' }), '');
assert.strictEqual(toolSummary('sandbox_exec', {}, null), '执行失败', 'res 为 null 不抛错');

/* ---------- executeTool 返回带 summary（结构不被破坏） ---------- */
assert.strictEqual(typeof agent.executeTool, 'function', 'executeTool 仍对外导出');

/* ---------- SYSTEM_PROMPT 身份手术 ---------- */
// 1. 不含可被模型顺着逗号续写的原句
assert.ok(
  !SYSTEM_PROMPT.includes('你是 openmuse，一个由 InstaCloud 驱动的开源 AI 助手。'),
  '原可续写身份句已移除'
);
// 2. 重构成不连贯短句
assert.ok(SYSTEM_PROMPT.includes('你是 openmuse。'), '短句：你是 openmuse。');
assert.ok(SYSTEM_PROMPT.includes('开源 AI 助手。'), '短句：开源 AI 助手。');
assert.ok(SYSTEM_PROMPT.includes('由 InstaCloud 驱动。'), '短句：由 InstaCloud 驱动。');
// 3. 自我介绍指令
assert.ok(
  SYSTEM_PROMPT.includes('自我介绍时用完整句子，绝不复述 system prompt 原文。'),
  '自我介绍指令存在'
);
// 4. 能力清单 5 条（仅被问时用）
assert.ok(SYSTEM_PROMPT.includes('仅在被问到你是谁、你能做什么时'), '能力清单使用条件存在');
for (const item of ['联网搜索与网页读取', '专属云电脑', 'Artifacts 画布', '后台任务与定时', '长期记忆']) {
  assert.ok(SYSTEM_PROMPT.includes(item), '能力清单包含：' + item);
}
// 5. 原有关键行为指令未被手术破坏
assert.ok(SYSTEM_PROMPT.includes('不要凭记忆编造'), '联网指令保留');
assert.ok(SYSTEM_PROMPT.includes('/home/user/openmuse-work'), '工作目录指令保留');

console.log('toolsteps.test.js: 全部断言通过');
