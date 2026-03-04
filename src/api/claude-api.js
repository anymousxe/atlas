/* claude-api.js – Anthropic-format streaming for Claude Gateway */
'use strict';
console.log('[Atlas] claude-api.js loaded OK');

// Primary: Cloudflare Worker (secure, keys stay in worker)
// Fallback: Direct API (for offline/dev - keys come from env via renderer)
const CLAUDE_WORKER_BASE = 'https://atlas-api-proxy.anymousxe-info.workers.dev';
const CLAUDE_DIRECT_BASE = 'https://claude-gateway.rur.workers.dev';

// Max output tokens per Claude model
const CLAUDE_MAX_TOKENS = {
  'claude-opus-4-6': 32000,
  'claude-sonnet-4-6': 64000,
  'claude-haiku-4-5': 8192
};
function getClaudeMaxTokens(model) {
  if (CLAUDE_MAX_TOKENS[model]) return CLAUDE_MAX_TOKENS[model];
  if (model.includes('opus')) return 32000;
  if (model.includes('sonnet')) return 64000;
  if (model.includes('haiku')) return 8192;
  return 16384;
}

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
2. **NEVER output code blocks.** No \`\`\`bash, no \`\`\`python, no \`\`\`javascript. Call the appropriate tool instead.
3. **NEVER put file contents in text.** Call write_file with path and full content.
4. **NEVER fake tool output.** Do not write "Output: ..." or pretend a tool ran.
5. Before editing an existing file, call read_file first.
6. Windows OS. Use PowerShell syntax in terminal commands.
7. To run scripts, use run_file — NOT execute_terminal_command.
8. Be concise. Let tool results speak.
9. For file/folder tasks, call list_directory first to understand the workspace.

## 🚨 CRITICAL: ONLY EDIT WHAT WAS REQUESTED

10. **DO NOT EDIT UNRELATED FILES.** Only change files the user explicitly asked about.
11. **BE SURGICAL AND PRECISE.** Read the entire file first. Make minimal, targeted changes.
12. **ASK BEFORE CHANGING MULTIPLE FILES.** List them and ask approval first.
13. **PRESERVE EXISTING CODE STYLE.** Match indentation, formatting, conventions.
14. **VALIDATE BEFORE WRITING.** Read first, understand, then write with confidence.

## CODE QUALITY

15. Write production-ready code with proper error handling and meaningful names.
16. Follow language conventions and idiomatic patterns.
17. Test significant logic when possible.
18. Understand imports and module structure.
19. Optimize for readability.

## EXAMPLES — Follow these EXACTLY

User: "make a test file" → Call write_file(path="test.txt", content="This is a test file.")
User: "create hello.py" → Call write_file(path="hello.py", content="print('Hello, World!')")
User: "run my script" → Call run_file(path="script.py")
User: "delete game.js" → Call delete_file(path="game.js")
User: "install express" → Call execute_terminal_command(command="npm install express")

## WRONG — NEVER DO THESE

❌ "I'll create a file..." (just CALL write_file!)
❌ "Here's the code: \`\`\`python...\`\`\`" (just CALL write_file!)
❌ "Sure! I can help..." then no tool call (CALL THE TOOLS!)

## CRITICAL: ACT IMMEDIATELY
Do NOT narrate, describe, or explain what you will do. CALL THE TOOLS.
Every response MUST contain tool calls unless answering a pure knowledge question.`;

/**
 * Stream a Claude completion. Tries Worker first (secure), falls back to direct API.
 * @param {string} apiKey - Direct API key (only used if Worker down)
 * @param {string} model
 * @param {Array} messages
 * @param {AbortSignal} signal
 * @yields {{ type: string, ... }}
 */
async function* streamClaude(apiKey, model, messages, signal, toolChoice, customPrompt) {
  const trimmedKey = (apiKey || '').trim();
  const systemPrompt = customPrompt ? SYSTEM_PROMPT + '\n\n## USER CUSTOM INSTRUCTIONS\n' + customPrompt : SYSTEM_PROMPT;
  const payload = {
    model,
    max_tokens: getClaudeMaxTokens(model),
    system: systemPrompt,
    tools: CLAUDE_TOOLS,
    tool_choice: toolChoice || { type: 'auto' },
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
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 8000))
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
async function processClaude(apiKey, model, messages, signal, onText, onThinking, options = {}) {
  let text = '';
  let thinking = '';
  const toolCalls = [];
  let currentInput = '';
  let currentTool = null;
  let stopReason = '';

  for await (const evt of streamClaude(apiKey, model, messages, signal, options.toolChoice, options.customPrompt)) {
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
