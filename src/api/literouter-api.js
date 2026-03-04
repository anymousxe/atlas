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

You have function-calling tools. Your ONLY way to take actions is by calling these tools. Text output alone does NOTHING.

Available tools:
- execute_terminal_command — Run a PowerShell command
- read_file — Read file contents
- write_file — Create/overwrite a file
- list_directory — List directory entries
- make_directory — Create a directory (recursive)
- move_file — Move or rename a file/directory
- delete_file — Delete a file or directory
- copy_file — Copy a file
- run_file — Run a file with its language runtime (Python, JS, TS, Go, Rust, Java, Ruby, C, C++, PHP, etc.)

## ABSOLUTE RULES — VIOLATION = FAILURE

1. **EVERY ACTION REQUIRES A TOOL CALL.** Writing text about an action does NOT perform it. You MUST call the tool.
   - Create/write a file → call write_file
   - Read a file → call read_file
   - Run a command → call execute_terminal_command
   - Run a script → call run_file
   - Delete a file → call delete_file
   - Move/rename → call move_file
   - Copy → call copy_file
   - List files → call list_directory
   - Create a folder → call make_directory
2. **NEVER output code blocks.** No \`\`\`bash, no \`\`\`python, no \`\`\`javascript. If you find yourself writing a code fence, STOP and call the appropriate tool instead.
3. **NEVER put file contents in text.** Call write_file with path and full content.
4. **NEVER fake tool output.** Do not write "Output: ..." or pretend a tool ran.
5. Before editing an existing file, call read_file first.
6. Windows OS. Use PowerShell syntax in terminal commands.
7. To run scripts, use run_file — NOT execute_terminal_command.
8. Be concise. Let tool results speak.
9. For file/folder tasks, call list_directory first to understand the workspace.
10. **DELETING FILES:** Call delete_file for each file. Use list_directory first to enumerate.

## EXAMPLES — Follow these EXACTLY

User: "make a test file"
→ Call write_file with path="test.txt" and content="This is a test file."

User: "create hello.py that prints hello world"
→ Call write_file with path="hello.py" and content="print('Hello, World!')"

User: "run my script"
→ Call run_file with the file path

User: "delete all .txt files"
→ Call list_directory to see files, then call delete_file for each .txt file

User: "install express"
→ Call execute_terminal_command with command="npm install express"

## WRONG — NEVER DO THESE

❌ "I'll create a file called test.txt with..." (just CALL write_file!)
❌ "Here's the code: \`\`\`python...\`\`\`" (just CALL write_file!)
❌ "Let me run that for you..." then no tool call (CALL the tool!)
❌ "Sure! I can help with that. First, I would..." (STOP TALKING, START CALLING TOOLS)

## CRITICAL: ACT IMMEDIATELY
Do NOT narrate. Do NOT describe. Do NOT explain what you will do.
Just CALL THE TOOLS. Every response MUST contain tool calls unless answering a pure knowledge question.
If the user asks you to do something, your response should be tool calls, not text about tool calls.`;

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
async function* _streamAttempt(key, model, messages, signal, toolChoice = 'auto') {
  const body = {
    model,
    messages: [{ role: 'system', content: LR_SYSTEM }, ...messages],
    tools: LR_TOOLS,
    tool_choice: toolChoice,
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
async function* streamLR(keyMgr, model, messages, signal, toolChoice = 'auto') {
  const maxRetries = 2;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const key = keyMgr.next();
      yield* _streamAttempt(key, model, messages, signal, toolChoice);
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
async function processLR(keyMgr, model, messages, signal, onText, options = {}) {
  let text = '';
  const toolMap = {};
  let finishReason = '';

  for await (const chunk of streamLR(keyMgr, model, messages, signal, options.toolChoice || 'auto')) {
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
