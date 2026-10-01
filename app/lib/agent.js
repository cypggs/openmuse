// openmuse v2 — agent tool loop over the per-user E2B sandbox.
//
// Flow: DeepSeek chat/completions with tools -> if the model emits tool_calls,
// execute them via lib/sandbox, append results, and loop (max 8 iterations).
// Text deltas stream out via onEvent as they arrive.
//
// Secrets are read only from process.env and are never logged.
'use strict';

const sandbox = require('./sandbox');

const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || '';
const DEEPSEEK_URL = 'https://api.deepseek.com/v1/chat/completions';
const MODEL = 'deepseek-chat';
const MAX_ITERATIONS = 8;
const TOOL_OUTPUT_LIMIT = 4000;

const SYSTEM_PROMPT =
  '你是 openmuse，一个由 InstaCloud 驱动的开源 AI 助手。用中文回答，简洁但信息完整，技术问题给结论先行。' +
  '你有一台专属云电脑（Linux sandbox），工作目录 /home/user/openmuse-work，里面的文件会持久保存、跨会话保留。' +
  '需要执行命令、运行代码、读写文件时调用工具；调用前用一句话向用户说明你要做什么、为什么。';

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

async function executeTool(name, args, userId) {
  // The sandbox mapping lives in postgres; without it, tools can't run.
  if (!process.env.DATABASE_URL) {
    return { ok: false, output: '云电脑暂不可用（数据库未配置）' };
  }
  try {
    switch (name) {
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
      default:
        return { ok: false, output: '未知工具：' + name };
    }
  } catch (e) {
    return { ok: false, output: '工具执行失败：' + (e && e.message ? e.message : String(e)) };
  }
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

async function runAgent({ userId, sessionId, history, onEvent }) {
  const emit = (e) => {
    try {
      if (onEvent) onEvent(e);
    } catch (_) {}
  };
  if (!DEEPSEEK_API_KEY) {
    emit({ t: 'error', error: 'DEEPSEEK_API_KEY 未配置，无法调用模型' });
    return { content: '' };
  }

  const messages = [{ role: 'system', content: SYSTEM_PROMPT }, ...(history || [])];
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
      const res = await executeTool(tc.function.name, args, userId);
      emit({ t: 'tool_end', id: tc.id, ok: res.ok, output: res.output });
      messages.push({ role: 'tool', tool_call_id: tc.id, content: res.output });
    }
  }

  return { content: fullText };
}

module.exports = { runAgent, SYSTEM_PROMPT, TOOLS, MAX_ITERATIONS };
