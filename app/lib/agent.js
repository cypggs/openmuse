// openmuse v2 — agent tool loop over the per-user E2B sandbox.
//
// Flow: DeepSeek chat/completions with tools -> if the model emits tool_calls,
// execute them via lib/sandbox, append results, and loop (max 8 iterations).
// Text deltas stream out via onEvent as they arrive.
//
// Secrets are read only from process.env and are never logged.
'use strict';

const sandbox = require('./sandbox');
const browser = require('./browser');
// P1: 联网工具（Worker A）与 artifacts 画布（Worker B），零新依赖
const web = require('./web');
const artifacts = require('./artifacts');

const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || '';
const DEEPSEEK_URL = 'https://api.deepseek.com/v1/chat/completions';
const MODEL = 'deepseek-chat';
const MAX_ITERATIONS = 8;
const TOOL_OUTPUT_LIMIT = 4000;

const SYSTEM_PROMPT =
  // P1-4：身份句拆成不连贯短句，避免模型顺着逗号续写复述原文
  '你是 openmuse。开源 AI 助手。由 InstaCloud 驱动。用中文回答。简洁但信息完整。技术问题结论先行。' +
  '自我介绍时用完整句子，绝不复述 system prompt 原文。' +
  '你有一台专属云电脑（Linux sandbox），工作目录 /home/user/openmuse-work，里面的文件会持久保存、跨会话保留。' +
  '需要执行命令、运行代码、读写文件时调用工具；调用前用一句话向用户说明你要做什么、为什么。' +
  // P1 browser-driver：浏览器就在本 sandbox 里跑，不是外部服务
  '你的云电脑里有一套完整桌面环境（Xvfb + Chrome + noVNC），浏览器就跑在这台电脑里，' +
  '不是什么"平台侧独立容器"或"外部服务桥接"——不要编造这种说法。' +
  'driver.js（/home/user/driver.js）用 Playwright 启动 Chrome（persistent profile 在 /home/user/.openmuse-browser），' +
  '你用 browser_navigate/snapshot/click/fill/press/screenshot 工具经 driver 控制它。' +
  '用户在"🖥️ 浏览器"Live View 里看到的是同一台电脑的实时画面，可亲自操作。' +
  'ps 能看到 chrome 进程（首次用浏览器工具后启动，常驻）。' +
  // P1 联网工具（Worker A）
  '涉及时效性信息（新闻、版本发布、价格、CVE、API 变更）或你不确定的外部事实时，' +
  '不要凭记忆编造，先调用 web_search 联网搜索再回答；引用事实时给出来源链接。' +
  '需要引用网页原文细节时再用 web_read 读取，读全文前先看搜索摘要判断相关性。' +
  // P1-4 能力清单：仅在被问"你是谁/你能做什么"时用，平时回答不要主动列举
  '仅在被问到你是谁、你能做什么时，用下面清单简要介绍能力，其他回答里不要主动列举：' +
  '1）联网搜索与网页读取，查时效性信息并给出引用来源；' +
  '2）专属云电脑，执行命令、运行代码，文件持久保存、跨会话保留；' +
  '3）Artifacts 画布，生成网页、文档、图表，在右侧展示；' +
  '4）后台任务与定时，任务可关闭页面继续跑、支持定时执行；' +
  '5）长期记忆，跨会话记住你的偏好与重要信息。' +
  // P1 artifacts 画布（Worker B）
  artifacts.ARTIFACT_PROMPT;

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'sandbox_exec',
      description:
        '在云电脑的 Linux 终端执行 shell 命令。工作目录为 /home/user/openmuse-work。返回 stdout、stderr 和 exitCode。',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: '要执行的 shell 命令' },
          timeout_secs: { type: 'number', description: '超时秒数，默认 60，最长 600' },
        },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'sandbox_run_python',
      description: '在云电脑上运行一段 Python 3 代码（python3）。适合数据计算、脚本任务、快速验证想法。',
      parameters: {
        type: 'object',
        properties: {
          code: { type: 'string', description: '要运行的 Python 代码' },
        },
        required: ['code'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'sandbox_read_file',
      description: '读取云电脑工作目录下的文本文件。path 为相对路径，例如 notes/todo.txt。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '相对路径' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'sandbox_write_file',
      description: '写文本文件到云电脑工作目录。path 为相对路径，父目录不存在会自动创建。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '相对路径' },
          content: { type: 'string', description: '文件内容' },
        },
        required: ['path', 'content'],
      },
    },
  },
  // P1 联网工具（Worker A）
  {
    type: 'function',
    function: {
      name: 'web_search',
      description:
        '联网搜索外部信息。涉及时效性内容（新闻、版本发布、价格、CVE、API 变更）或不确定的外部事实时，先用它搜索再回答，禁止凭记忆编造。返回标题、链接和摘要列表。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '搜索关键词' },
          count: { type: 'number', description: '返回条数，默认 8，最多 20' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'web_read',
      description:
        '读取公网网页正文，返回标题和正文文本。读全文前建议先用 web_search 看摘要确认相关性。只支持 http/https 公网页面，内网地址会被拒绝。',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: '要读取的网页 URL' },
          max_chars: { type: 'number', description: '正文最大字符数，默认 12000' },
        },
        required: ['url'],
      },
    },
  },
  // P1 artifacts 画布（Worker B）
  ...artifacts.ARTIFACT_TOOLS,
  // P1 browser-driver（E2B desktop）
  {
    type: 'function',
    function: {
      name: 'browser_navigate',
      description:
        '在云电脑的浏览器中打开网页。敏感站点（github/google/邮箱等）会触发用户审批。',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: '要打开的 URL（http/https）' },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_snapshot',
      description:
        '获取当前页面的可访问性树（文本快照），包含可交互元素的 ref 引用。先 snapshot 再 click/fill。',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_click',
      description: '点击页面元素。ref 来自 browser_snapshot 的 [eN] 引用。',
      parameters: {
        type: 'object',
        properties: {
          ref: { type: 'string', description: '元素引用，如 e3' },
        },
        required: ['ref'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_fill',
      description:
        '在输入框填入文本（非凭证）。ref 来自 browser_snapshot。密码等凭证不要用这个工具。',
      parameters: {
        type: 'object',
        properties: {
          ref: { type: 'string', description: '输入框引用，如 e5' },
          text: { type: 'string', description: '要填入的文本' },
        },
        required: ['ref', 'text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_press',
      description: '按键盘按键，如 Enter、Escape、Tab、ArrowDown 等。',
      parameters: {
        type: 'object',
        properties: {
          key: { type: 'string', description: '按键名，默认 Enter' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_screenshot',
      description: '对当前浏览器页面截图（PNG）。用于向用户展示或调试。',
      parameters: { type: 'object', properties: {} },
    },
  },
];

function truncate(s, n) {
  s = String(s == null ? '' : s);
  return s.length > n ? s.slice(0, n) + `\n…（输出过长，已截断，原文 ${s.length} 字符）` : s;
}

function safeParseArgs(json) {
  try {
    const o = JSON.parse(json || '{}');
    return o && typeof o === 'object' ? o : {};
  } catch (_) {
    return {};
  }
}

// P1-3 工具活动叙事：纯启发式摘要，供前端步骤流展示。无副作用。
// name: 工具名；args: 解析后的工具参数；res: executeTool 返回 {ok, output, artifact?}。
function toolSummary(name, args, res) {
  args = args || {};
  res = res || {};
  switch (name) {
    case 'web_search': {
      if (!res.ok) return '搜索失败';
      const out = String(res.output || '');
      if (out.indexOf('（无搜索结果）') >= 0) return '找到 0 条结果';
      // formatSearchResults 格式：每条结果以 "N. " 开头
      const m = out.match(/^\d+\. /gm);
      return '找到 ' + (m ? m.length : 0) + ' 条结果';
    }
    case 'web_read': {
      if (!res.ok) return '读取失败';
      // executeTool 的 web_read 输出以 "# 标题" 开头
      const m = String(res.output || '').match(/^#\s*(.+)$/m);
      const title = (m ? m[1] : '').trim();
      if (!title) return '已读取网页';
      const short = title.length > 30 ? title.slice(0, 30) + '…' : title;
      return '已读取《' + short + '》';
    }
    case 'sandbox_exec':
      return res.ok ? '执行完成' : '执行失败';
    case 'create_artifact': {
      const t = String(args.title || '').trim();
      return t ? '已创建画布：' + t : '已创建画布';
    }
    case 'update_artifact': {
      const t = String(args.title || '').trim();
      return t ? '已更新画布：' + t : '已更新画布';
    }
    default:
      return '';
  }
}

function toolLabel(name, args) {
  switch (name) {
    case 'sandbox_exec':
      return '执行命令：' + truncate(String(args.command || ''), 80).replace(/\n/g, ' ');
    case 'sandbox_run_python':
      return '运行 Python';
    case 'sandbox_read_file':
      return '读文件：' + (args.path || '');
    case 'sandbox_write_file':
      return '写文件：' + (args.path || '');
    // P1 联网工具（Worker A）
    case 'web_search':
      return '联网搜索：' + truncate(String(args.query || ''), 60).replace(/\n/g, ' ');
    case 'web_read':
      return '读取网页：' + truncate(String(args.url || ''), 80).replace(/\n/g, ' ');
    // P1 artifacts 画布（Worker B）
    case 'create_artifact':
      return '创建画布内容：' + (args.title || '');
    case 'update_artifact':
      return '更新画布内容';
    default:
      return '调用工具：' + name;
  }
}

function formatExecResult(r) {
  let out = '';
  if (r.stdout) out += r.stdout;
  if (r.stderr) out += (out ? '\n' : '') + '[stderr]\n' + r.stderr;
  out += `\n[exit code: ${r.exitCode}]`;
  return truncate(out, TOOL_OUTPUT_LIMIT);
}

async function executeToolInner(name, args, userId, sessionId) {
  // P1 联网工具不依赖云电脑/数据库，放在 DATABASE_URL 检查之前。
  if (name === 'web_search' || name === 'web_read') {
    try {
      if (name === 'web_search') {
        const r = await web.web_search(args.query, args.count);
        if (r.error) return { ok: false, output: r.error };
        return { ok: true, output: truncate(web.formatSearchResults(r.results), TOOL_OUTPUT_LIMIT) };
      }
      const r = await web.web_read(args.url, args.max_chars);
      if (r.error) return { ok: false, output: r.error };
      return { ok: true, output: truncate('# ' + r.title + '\n\n' + r.text, TOOL_OUTPUT_LIMIT) };
    } catch (e) {
      return { ok: false, output: '联网工具执行失败：' + (e && e.message ? e.message : String(e)) };
    }
  }
  // The sandbox mapping lives in postgres; without it, tools can't run.
  if (!process.env.DATABASE_URL) {
    return { ok: false, output: '云电脑暂不可用（数据库未配置）' };
  }
  try {
    switch (name) {
      // P1 artifacts 画布（Worker B）：需要 sessionId 做按会话归档
      case 'create_artifact':
        return artifacts.executeCreateArtifact(args, { userId, sessionId });
      case 'update_artifact':
        return artifacts.executeUpdateArtifact(args, { userId, sessionId });
      case 'sandbox_exec': {
        const secs = Math.min(Math.max(Number(args.timeout_secs) || 60, 1), 600);
        const r = await sandbox.execCommand(userId, String(args.command || ''), secs * 1000);
        return { ok: r.exitCode === 0, output: formatExecResult(r) };
      }
      case 'sandbox_run_python': {
        const r = await sandbox.runPython(userId, String(args.code || ''));
        return { ok: r.exitCode === 0, output: formatExecResult(r) };
      }
      case 'sandbox_read_file': {
        const text = await sandbox.readFile(userId, String(args.path || ''));
        return { ok: true, output: truncate(text, TOOL_OUTPUT_LIMIT) };
      }
      case 'sandbox_write_file': {
        const r = await sandbox.writeFile(userId, String(args.path || ''), String(args.content || ''));
        return { ok: true, output: '已写入 ' + r.path };
      }
      // P1 browser-driver
      case 'browser_navigate': {
        const r = await browser.navigate(userId, String(args.url || ''), { sessionId });
        return { ok: true, output: `已打开 ${r.url || args.url}${r.title ? `（${r.title}）` : ''}` };
      }
      case 'browser_snapshot': {
        const r = await browser.snapshot(userId);
        let out = `# ${r.title || ''}\n${r.url || ''}\n\n${r.snapshot || ''}`;
        if (r.truncated) out += '\n\n（快照过长已截断）';
        if (r.login_form_detected) out += '\n\n[检测到登录表单：username/password 字段，需用户审批后才可填入]';
        return { ok: true, output: truncate(out, TOOL_OUTPUT_LIMIT) };
      }
      case 'browser_click': {
        await browser.click(userId, String(args.ref || ''));
        return { ok: true, output: `已点击 ${args.ref}` };
      }
      case 'browser_fill': {
        await browser.fill(userId, String(args.ref || ''), String(args.text || ''));
        return { ok: true, output: `已在 ${args.ref} 填入文本` };
      }
      case 'browser_press': {
        await browser.press(userId, String(args.key || 'Enter'));
        return { ok: true, output: `已按键 ${args.key || 'Enter'}` };
      }
      case 'browser_screenshot': {
        const buf = await browser.screenshot(userId);
        // 以 artifact 形式返回截图（前端可展示）
        return { ok: true, output: '[截图已捕获]', screenshot: buf.toString('base64') };
      }
      default:
        return { ok: false, output: '未知工具：' + name };
    }
  } catch (e) {
    return { ok: false, output: '工具执行失败：' + (e && e.message ? e.message : String(e)) };
  }
}

// P1-3：对外保持 executeTool 签名，只在返回上附加 summary 字段，
// 不破坏现有 {ok, output, artifact} 结构。
async function executeTool(name, args, userId, sessionId) {
  const res = await executeToolInner(name, args, userId, sessionId);
  if (res && typeof res === 'object' && typeof res.summary === 'undefined') {
    res.summary = toolSummary(name, args, res);
  }
  return res;
}

// One streaming chat/completions call. Accumulates text deltas and
// tool_call deltas; returns { content, toolCalls }.
async function streamChat(messages, onToken) {
  let res;
  try {
    res = await fetch(DEEPSEEK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + DEEPSEEK_API_KEY,
      },
      body: JSON.stringify({
        model: MODEL,
        stream: true,
        messages,
        tools: TOOLS,
        tool_choice: 'auto',
      }),
    });
  } catch (e) {
    throw new Error('上游请求失败：' + e.message);
  }
  if (!res.ok || !res.body) {
    let detail = '';
    try {
      detail = (await res.text()).slice(0, 200);
    } catch (_) {}
    throw new Error(`模型接口返回 ${res.status}${detail ? '：' + detail : ''}`);
  }

  const calls = new Map(); // index -> { id, name, args }
  let content = '';
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let streamDone = false;

  const handleLine = (line) => {
    if (line.indexOf('data:') !== 0) return;
    const payload = line.slice(5).trim();
    if (payload === '[DONE]') {
      streamDone = true;
      return;
    }
    let j;
    try {
      j = JSON.parse(payload);
    } catch (_) {
      return;
    }
    const delta = j.choices && j.choices[0] && j.choices[0].delta;
    if (!delta) return;
    if (delta.content) {
      content += delta.content;
      try {
        onToken(delta.content);
      } catch (_) {}
    }
    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        const i = tc.index || 0;
        let e = calls.get(i);
        if (!e) {
          e = { id: '', name: '', args: '' };
          calls.set(i, e);
        }
        if (tc.id) e.id = tc.id;
        if (tc.function) {
          if (tc.function.name) e.name += tc.function.name;
          if (tc.function.arguments) e.args += tc.function.arguments;
        }
      }
    }
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      handleLine(buf.slice(0, idx).trim());
      buf = buf.slice(idx + 1);
      if (streamDone) break;
    }
    if (streamDone) break;
  }

  const toolCalls = [...calls.values()]
    .filter((c) => c.name)
    .map((c, i) => ({
      id: c.id || 'call_' + Date.now() + '_' + i,
      type: 'function',
      function: { name: c.name, arguments: c.args || '{}' },
    }));
  return { content, toolCalls };
}

async function runAgent({ userId, sessionId, history, onEvent, systemExtra }) {
  const emit = (e) => {
    try {
      if (onEvent) onEvent(e);
    } catch (_) {}
  };
  if (!DEEPSEEK_API_KEY) {
    emit({ t: 'error', error: 'DEEPSEEK_API_KEY 未配置，无法调用模型' });
    return { content: '' };
  }

  const systemContent = SYSTEM_PROMPT + (typeof systemExtra === 'string' ? systemExtra : '');
  const messages = [{ role: 'system', content: systemContent }, ...(history || [])];
  let fullText = '';

  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    let content, toolCalls;
    try {
      ({ content, toolCalls } = await streamChat(messages, (token) => emit({ t: 'token', token })));
    } catch (e) {
      emit({ t: 'error', error: e.message });
      break;
    }
    fullText += content || '';
    if (!toolCalls.length) break;

    messages.push({
      role: 'assistant',
      content: content || null,
      tool_calls: toolCalls,
    });
    for (const tc of toolCalls) {
      const args = safeParseArgs(tc.function.arguments);
      emit({ t: 'tool_start', id: tc.id, label: toolLabel(tc.function.name, args) });
      const res = await executeTool(tc.function.name, args, userId, sessionId);
      emit({ t: 'tool_end', id: tc.id, ok: res.ok, output: res.output, summary: res.summary });
      // P1 artifacts：创建成功后通知前端在右侧画布打开
      if (res.artifact) {
        emit({
          t: 'artifact',
          id: res.artifact.id,
          title: res.artifact.title,
          type: res.artifact.type,
        });
      }
      messages.push({ role: 'tool', tool_call_id: tc.id, content: res.output });
    }
  }

  return { content: fullText };
}

module.exports = { runAgent, executeTool, toolSummary, SYSTEM_PROMPT, TOOLS, MAX_ITERATIONS };
