/* literouter-api.js – OpenAI-compatible streaming for LiteRouter */
'use strict';
console.log('[Atlas] literouter-api.js loaded OK');

// Primary: Cloudflare Worker (secure, keys stay in worker)
// Fallback: Direct API (for offline/dev - keys come from env via renderer)
const LR_WORKER_BASE = 'https://atlas-api-proxy.anymousxe-info.workers.dev';
const LR_DIRECT_BASE = 'https://api.literouter.com/v1';

const LR_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'execute_terminal_command',
      description: 'Run a shell command in the workspace terminal and return stdout + stderr.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The shell command to execute' }
        },
        required: ['command']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read the full contents of a file at the given path.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute or workspace-relative file path' }
        },
        required: ['path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Write (create or overwrite) a file at the given path with the provided content.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute or workspace-relative file path' },
          content: { type: 'string', description: 'Full file content to write' }
        },
        required: ['path', 'content']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'list_directory',
      description: 'List files and sub-directories in the given directory.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute or workspace-relative directory path' }
        },
        required: ['path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'make_directory',
      description: 'Create a directory (and any missing parent directories) at the given path.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute or workspace-relative directory path to create' }
        },
        required: ['path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'move_file',
      description: 'Move or rename a file or directory from old_path to new_path.',
      parameters: {
        type: 'object',
        properties: {
          old_path: { type: 'string', description: 'Current path of the file or directory' },
          new_path: { type: 'string', description: 'Destination path' }
        },
        required: ['old_path', 'new_path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'delete_file',
      description: 'Delete a file or directory at the given path. Directories are removed recursively.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute or workspace-relative path to delete' }
        },
        required: ['path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'copy_file',
      description: 'Copy a file from source path to destination path.',
      parameters: {
        type: 'object',
        properties: {
          source: { type: 'string', description: 'Source file path' },
          destination: { type: 'string', description: 'Destination file path' }
        },
        required: ['source', 'destination']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'run_file',
      description: 'Run/execute a file using the appropriate language runtime (Python, Node.js, Go, Rust, Java, Ruby, C/C++, PHP, etc). Returns stdout, stderr, and exit code.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute or workspace-relative path to the file to run' }
        },
        required: ['path']
      }
    }
  }
];

const LR_SYSTEM = `You are Atlas, an AI coding agent inside a desktop IDE.

You have tools available via function calling. You MUST call them to take actions:
- execute_terminal_command — Run a PowerShell command
- read_file — Read file contents
- write_file — Create/overwrite a file
- list_directory — List directory entries
- make_directory — Create a directory (recursive)
- move_file — Move or rename a file/directory
- delete_file — Delete a file or directory
- copy_file — Copy a file
- run_file — Run a file with its language runtime (auto-detects: Python, JS, TS, Go, Rust, Java, Ruby, C, C++, PHP, Lua, Dart, R, Kotlin, Swift, PowerShell, Bash)

## ABSOLUTE RULES — VIOLATION = FAILURE

1. **USE TOOLS FOR EVERY ACTION.** To run a command → call execute_terminal_command. To write a file → call write_file. To read → call read_file. To run a script → call run_file. To delete → call delete_file. To move/rename → call move_file. To copy → call copy_file. NEVER describe an action in text instead of performing it.
2. **NEVER put commands inside code blocks in your text.** If you write \`\`\`bash ... \`\`\` in your response, that is WRONG. Call execute_terminal_command instead.
3. **NEVER put file contents inside code blocks.** Call write_file with the path and content. ALWAYS output whole files, no truncating or skipping lines.
4. **NEVER fake tool output.** Do not write "Output: ..." or pretend a tool ran.
5. Before editing an existing file, call read_file first.
6. Windows OS. Use PowerShell syntax: Remove-Item, New-Item, Copy-Item, etc.
7. When asked to run a Python, JS, or other language file, use run_file — NOT execute_terminal_command.
8. Be concise. Let tool results speak.
9. For file/folder tasks, call list_directory first to understand workspace structure before editing.
10. **DELETING FILES:** When asked to delete/remove files, call delete_file for EACH file. To delete multiple files, call delete_file multiple times. Call list_directory first to enumerate what exists, then delete_file for each item. Do NOT use execute_terminal_command for deletions — use the delete_file tool.

Correct behavior: User says "create and run hello.py" → you call write_file, then run_file.
Correct behavior: User says "run my script" → you call run_file with the file path.
Correct behavior: User says "delete all files" → you call list_directory, then call delete_file for each file.
Correct behavior: User says "remove game.js" → you call delete_file with the path.
INCORRECT behavior: Writing a code block instead of calling a tool. NEVER DO THIS.
INCORRECT behavior: Saying "I'll delete the file" without calling delete_file. NEVER DO THIS.

## CRITICAL: ALWAYS USE TOOL CALLS IMMEDIATELY
Do NOT start your response with "I'll create..." or "Let me build...". Instead, IMMEDIATELY call the appropriate tools.
For large files: call write_file with the COMPLETE content. Do not hesitate or truncate.
You can call multiple tools in sequence — just START calling them right away.
Every response MUST contain at least one tool call unless you are answering a pure question.`;

/** Key manager with round-robin + retry */
class KeyManager {
  constructor(keys) {
    this.keys = keys.filter(k => k && k.trim());
    this.idx = 0;
  }
  get count() { return this.keys.length; }
  next() {
    if (!this.keys.length) return null;
    const k = this.keys[this.idx % this.keys.length];
    this.idx++;
    return k;
  }
}

/**
 * Resolve model name. kimi-k2.5 with thinking → kimi-k2-thinking.
 */
function resolveModel(model, thinking) {
  if (model === 'kimi-k2.5' && thinking) return 'kimi-k2-thinking';
  return model;
}

/**
 * Single attempt to stream a completion. Tries Worker first, falls back to direct API.
 * @param {string} key - Direct API key (only used if Worker down)
 */
async function* _streamAttempt(key, model, messages, signal) {
  const body = {
    model,
    messages: [{ role: 'system', content: LR_SYSTEM }, ...messages],
    tools: LR_TOOLS,
    tool_choice: 'auto',
    stream: true,
    max_tokens: 64000
  };

  // Try Worker first (secure path)
  let res;
  try {
    res = await Promise.race([
      fetch(LR_WORKER_BASE, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          service: 'literouter',
          endpoint: '/v1/chat/completions',
          payload: body,
          headers: {}
        }),
        signal
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 8000))
    ]);
    if (!res.ok) throw new Error(`Worker ${res.status}`);
  } catch (workerErr) {
    // Fallback to direct API
    console.log(`[LiteRouter] Worker unavailable, using direct API with key:`, workerErr.message);
    if (!key) {
      const err = new Error('LiteRouter: Worker unavailable and no API key for fallback. Add keys to .env');
      err.status = 503;
      throw err;
    }
    res = await fetch(`${LR_DIRECT_BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`
      },
      body: JSON.stringify(body),
      signal
    });
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    console.error(`[LiteRouter] Error ${res.status} for model "${model}" — ${text.slice(0, 500)}`);
    const err = new Error(`LiteRouter ${res.status}: ${text.slice(0, 300)}`);
    err.status = res.status;
    if (res.status >= 500) {
      err.status = 500;
    } else if (res.status === 429) {
      err.status = 429;
    }
    throw err;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() || '';
    for (const line of lines) {
      if (line.startsWith('data: ')) {
        const raw = line.slice(6).trim();
        if (!raw || raw === '[DONE]') continue;
        try { yield JSON.parse(raw); } catch {}
      }
    }
  }
}

/**
 * Stream with retry. Tries to use Worker, falls back to direct API with key rotation.
 */
async function* streamLR(keyMgr, model, messages, signal) {
  const maxRetries = 2;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const key = keyMgr.next();
      yield* _streamAttempt(key, model, messages, signal);
      return;
    } catch (err) {
      if (signal && signal.aborted) throw err;
      if ((err.status === 429 || err.status >= 500) && attempt < maxRetries - 1) {
        console.warn(`LiteRouter attempt ${attempt + 1} failed (${err.status}), retrying...`);
        await new Promise(r => setTimeout(r, 500 + attempt * 300));
        continue;
      }
      throw err;
    }
  }
  throw new Error('LiteRouter worker unavailable after retries.');
}

/**
 * Process a full LiteRouter stream, accumulating text & tool calls.
 * Returns { text, toolCalls: [{ id, name, args }], finishReason }
 */
async function processLR(keyMgr, model, messages, signal, onText) {
  let text = '';
  const toolMap = {};
  let finishReason = '';

  for await (const chunk of streamLR(keyMgr, model, messages, signal)) {
    const c = chunk.choices && chunk.choices[0];
    if (!c) continue;
    const d = c.delta;
    if (!d) continue;

    if (d.content) {
      text += d.content;
      if (onText) onText(d.content);
    }

    if (d.tool_calls) {
      for (const tc of d.tool_calls) {
        const idx = tc.index ?? 0;
        if (!toolMap[idx]) toolMap[idx] = { id: '', name: '', args: '' };
        if (tc.id) toolMap[idx].id = tc.id;
        if (tc.function) {
          if (tc.function.name) toolMap[idx].name = tc.function.name;
          if (tc.function.arguments) toolMap[idx].args += tc.function.arguments;
        }
      }
    }

    if (c.finish_reason) finishReason = c.finish_reason;
  }

  const toolCalls = Object.values(toolMap).map(tc => {
    let parsed = {};
    try { parsed = JSON.parse(tc.args); } catch {}
    return { id: tc.id, name: tc.name, args: parsed };
  });

  return { text, toolCalls, finishReason };
}

/** Build OpenAI assistant message for conversation history */
function buildLRAssistantMsg(text, toolCalls) {
  const msg = { role: 'assistant', content: text || null };
  if (toolCalls.length) {
    msg.tool_calls = toolCalls.map(tc => ({
      id: tc.id,
      type: 'function',
      function: { name: tc.name, arguments: JSON.stringify(tc.args) }
    }));
  }
  return msg;
}

/** Build tool result messages for OpenAI format */
function buildLRToolResults(toolCalls, results) {
  return toolCalls.map((tc, i) => ({
    role: 'tool',
    tool_call_id: tc.id,
    content: results[i] || ''
  }));
}
