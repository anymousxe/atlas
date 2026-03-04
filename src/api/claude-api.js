/* claude-api.js – Anthropic-format streaming for Claude Gateway */
'use strict';
console.log('[Atlas] claude-api.js loaded OK');

// Primary: Cloudflare Worker (secure, keys stay in worker)
// Fallback: Direct API (for offline/dev - keys come from env via renderer)
const CLAUDE_WORKER_BASE = 'http://localhost:8787';
const CLAUDE_DIRECT_BASE = 'https://claude-gateway.rur.workers.dev';

const CLAUDE_TOOLS = [
  {
    name: 'execute_terminal_command',
    description: 'Run a shell command in the workspace terminal and return stdout + stderr.',
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The shell command to execute' }
      },
      required: ['command']
    }
  },
  {
    name: 'read_file',
    description: 'Read the full contents of a file at the given path.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute or workspace-relative file path' }
      },
      required: ['path']
    }
  },
  {
    name: 'write_file',
    description: 'Write (create or overwrite) a file at the given path with the provided content.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute or workspace-relative file path' },
        content: { type: 'string', description: 'Full file content to write' }
      },
      required: ['path', 'content']
    }
  },
  {
    name: 'list_directory',
    description: 'List files and sub-directories in the given directory.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute or workspace-relative directory path' }
      },
      required: ['path']
    }
  },
  {
    name: 'make_directory',
    description: 'Create a directory (and any missing parent directories) at the given path.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute or workspace-relative directory path to create' }
      },
      required: ['path']
    }
  },
  {
    name: 'move_file',
    description: 'Move or rename a file or directory from old_path to new_path.',
    input_schema: {
      type: 'object',
      properties: {
        old_path: { type: 'string', description: 'Current path of the file or directory' },
        new_path: { type: 'string', description: 'Destination path' }
      },
      required: ['old_path', 'new_path']
    }
  },
  {
    name: 'delete_file',
    description: 'Delete a file or directory at the given path. Directories are removed recursively.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute or workspace-relative path to delete' }
      },
      required: ['path']
    }
  },
  {
    name: 'copy_file',
    description: 'Copy a file from source path to destination path.',
    input_schema: {
      type: 'object',
      properties: {
        source: { type: 'string', description: 'Source file path' },
        destination: { type: 'string', description: 'Destination file path' }
      },
      required: ['source', 'destination']
    }
  },
  {
    name: 'run_file',
    description: 'Run/execute a file using the appropriate language runtime (Python, Node.js, Go, Rust, Java, Ruby, C/C++, PHP, etc). Returns stdout, stderr, and exit code.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute or workspace-relative path to the file to run' }
      },
      required: ['path']
    }
  }
];

const SYSTEM_PROMPT = `You are Atlas, an elite AI coding agent inside a desktop IDE.

You have tools available. You MUST call them to take actions:
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

1. **USE TOOLS FOR EVERY ACTION.** To run a command → call execute_terminal_command. To write a file → call write_file. To read → call read_file. To run a script → call run_file. NEVER describe an action in text instead of performing it.
2. **NEVER put commands inside code blocks in your text.** If you write \`\`\`bash ... \`\`\` in your response, that is WRONG. Call execute_terminal_command instead.
3. **NEVER put file contents inside code blocks.** Call write_file with the path and content. ALWAYS output whole files, no truncating or skipping lines.
4. **NEVER fake tool output.** Do not write "Output: ..." or pretend a tool ran.
5. Before editing an existing file, call read_file first.
6. Windows OS. Use PowerShell syntax: Remove-Item, New-Item, Copy-Item, etc.
7. When asked to run a Python, JS, or other language file, use run_file — NOT execute_terminal_command.
8. Be concise. Let tool results speak.
9. For file/folder tasks, call list_directory first to understand workspace structure before editing.

## 🚨 CRITICAL: ONLY EDIT WHAT WAS REQUESTED

10. **DO NOT EDIT UNRELATED FILES.** If the user asks you to change ONE file, only change THAT file. Do NOT "helpfully" edit other files unless explicitly asked or absolutely necessary to fix a direct error.
11. **BE SURGICAL AND PRECISE.** Use precise find-replace operations. Read the entire file first. Understand context. Make minimal, targeted changes. No unnecessary reformatting or reorganization.
12. **ASK BEFORE CHANGING MULTIPLE FILES.** If you determine multiple files need changes, explicitly list them and ask approval before proceeding.
13. **PRESERVE EXISTING CODE STYLE.** Match indentation, formatting, and conventions already in the file. Do not refactor unrelated code.
14. **VALIDATE BEFORE WRITING.** Always read the file first (rule 5 + 11), ensure you understand exactly what to change, then write with confidence.

## CODE QUALITY & BEST PRACTICES

15. **WRITE PRODUCTION-READY CODE.** Use proper error handling, type hints (TypeScript/Python), meaningful variable names, comments for complex logic.
16. **FOLLOW LANGUAGE CONVENTIONS.** Use idiomatic patterns: async/await (JS), context managers (Python), proper typing, error bounds checking.
17. **TEST YOUR CODE.** When you write significant logic, run tests or validate with run_file to ensure it works before declaring success.
18. **REASON ABOUT DEPENDENCIES.** Understand imports, module structure, and how code integrates. Don't blindly copy-paste.
19. **OPTIMIZE FOR READABILITY.** Code is read more than written. Use clear names, logical structure, and helpful comments.

## WORKFLOW

Correct behavior: User says "change line 10 in config.js" → you read the file, find line 10, make ONLY that change, save it.
Correct behavior: User says "fix the bug in app.py" → you read app.py, identify the bug, fix only that bug, run tests if possible.
INCORRECT behavior: User asks for ONE file change and you edit 3 other files "for consistency".
INCORRECT behavior: Writing code blocks instead of using tools.
INCORRECT behavior: Reformatting a file when not asked to.

## CRITICAL: ALWAYS USE TOOL CALLS IMMEDIATELY
Do NOT start your response with "I'll create..." or "Let me build...". Instead, IMMEDIATELY call the appropriate tools.
For large files: call write_file with the COMPLETE content. Do not hesitate or truncate.
You can call multiple tools in sequence — just START calling them right away.
Every response MUST contain at least one tool call unless you are answering a pure question.`;

/**
 * Stream a Claude completion. Tries Worker first (secure), falls back to direct API.
 * @param {string} apiKey - Direct API key (only used if Worker down)
 * @param {string} model
 * @param {Array} messages
 * @param {AbortSignal} signal
 * @yields {{ type: string, ... }}
 */
async function* streamClaude(apiKey, model, messages, signal) {
  const trimmedKey = (apiKey || '').trim();
  const payload = {
    model,
    max_tokens: 32768,
    system: SYSTEM_PROMPT,
    tools: CLAUDE_TOOLS,
    tool_choice: { type: 'auto' },
    messages,
    stream: true
  };

  // Try Worker first (secure path)
  let res;
  try {
    res = await Promise.race([
      fetch(CLAUDE_WORKER_BASE, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          service: 'claude',
          endpoint: '/v1/messages',
          payload,
          headers: { 'anthropic-version': '2023-06-01' }
        }),
        signal
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000))
    ]);
    if (!res.ok) throw new Error(`Worker ${res.status}`);
  } catch (workerErr) {
    // Fallback to direct API if worker fails
    console.log('[Claude] Worker unavailable, using direct API fallback:', workerErr.message);
    if (!trimmedKey) {
      throw new Error('Worker unavailable and no API key for fallback. Set CLAUDE_API_KEY in .env');
    }
    res = await fetch(`${CLAUDE_DIRECT_BASE}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': trimmedKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(payload),
      signal
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      if (res.status === 401) throw new Error('Claude 401: Invalid API key in .env');
      throw new Error(`Claude ${res.status}: ${text.slice(0, 300)}`);
    }
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
 * Process a full stream, accumulating text & tool_use blocks.
 * Returns { text, toolCalls: [{ id, name, input }], stopReason }
 */
async function processClaude(apiKey, model, messages, signal, onText, onThinking) {
  let text = '';
  let thinking = '';
  const toolCalls = [];
  let currentInput = '';
  let currentTool = null;
  let stopReason = '';

  for await (const evt of streamClaude(apiKey, model, messages, signal)) {
    const t = evt.type;

    if (t === 'content_block_start') {
      const cb = evt.content_block;
      if (cb.type === 'tool_use') {
        currentTool = { id: cb.id, name: cb.name, input: '' };
        currentInput = '';
      }
    } else if (t === 'content_block_delta') {
      const d = evt.delta;
      if (d.type === 'text_delta') {
        text += d.text;
        if (onText) onText(d.text);
      } else if (d.type === 'thinking_delta') {
        thinking += d.thinking;
        if (onThinking) onThinking(d.thinking);
      } else if (d.type === 'input_json_delta') {
        currentInput += d.partial_json;
      }
    } else if (t === 'content_block_stop') {
      if (currentTool) {
        try { currentTool.input = JSON.parse(currentInput); } catch { currentTool.input = {}; }
        toolCalls.push(currentTool);
        currentTool = null;
        currentInput = '';
      }
    } else if (t === 'message_delta') {
      if (evt.delta && evt.delta.stop_reason) stopReason = evt.delta.stop_reason;
    }
  }

  return { text, thinking, toolCalls, stopReason };
}

/** Build an assistant message from streamed result for conversation history */
function buildClaudeAssistantMsg(text, toolCalls) {
  const content = [];
  if (text) content.push({ type: 'text', text });
  for (const tc of toolCalls) {
    content.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.input });
  }
  return { role: 'assistant', content };
}

/** Build tool_result messages for Claude */
function buildClaudeToolResults(toolCalls, results) {
  const content = toolCalls.map((tc, i) => ({
    type: 'tool_result',
    tool_use_id: tc.id,
    content: results[i] || ''
  }));
  return { role: 'user', content };
}
