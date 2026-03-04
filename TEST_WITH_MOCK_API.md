# TEST YOUR WORKER WITH FAKE APIs (Works Right Now!)

## The Setup (Do This First)

### 1. Create `.env.local` File

In `c:\Users\aiden\opcode\worker\`, create a file called `.env.local` with this content:

```
CLAUDE_KEY=test-key-123
LITEROUTER_KEY=test-key-456
```

These are fake keys. They won't work with the real APIs, but they'll test our worker setup.

### 2. Install Dependencies

```bash
cd c:\Users\aiden\opcode\worker
npm install
```

---

## Test It (3 Terminals)

### Terminal 1: Start the Mock API

This simulates Claude and LiteRouter while they're down.

```bash
cd c:\Users\aiden\opcode
node scripts/mock-api.js
```

You should see:
```
🎭 Mock API Server Running
📍 http://localhost:6969
```

**Leave this running.**

---

### Terminal 2: Start Your Worker

```bash
cd c:\Users\aiden\opcode\worker
npm run dev
```

You should see:
```
⎔ Ready on http://localhost:8787
```

**Leave this running.**

---

### Terminal 3: Test It

Make a request to your worker:

```powershell
$body = @{
    service = "claude"
    endpoint = "/v1/messages"
    payload = @{
        model = "claude-opus-4-6"
        max_tokens = 100
        messages = @(@{role="user"; content="Say hello"})
    }
} | ConvertTo-Json

$response = Invoke-WebRequest -Uri "http://localhost:8787" `
  -Method POST `
  -Headers @{"Content-Type"="application/json"} `
  -Body $body

Write-Host $response.Content
```

---

## What You Should See

**In Terminal 3 (your test output):**
```json
{
  "id": "msg_test123",
  "type": "message",
  "content": [
    {
      "type": "text",
      "text": "Hello! I'm a mock API response. The real Claude API is currently down... [rest of message]"
    }
  ]
}
```

**In Terminal 2 (worker):**
```
[request log from worker]
```

**In Terminal 1 (mock API):**
```
✅ Claude API called with: {"service":"claude","endpoint":...
```

---

## That's It! 🎉

Your worker is working! Here's what happened:

1. You sent a request to the worker (Terminal 3)
2. Worker got it and checked the `CLAUDE_KEY` (it's `test-key-123`, which starts with `test-`)
3. Worker said "oh this is a fake key, so use the mock API instead" (http://localhost:6969)
4. Worker called the mock API WITH the key
5. Mock API responded with a fake message
6. Worker sent it back to you

**Your app never made the request directly.** The worker was the middleman.

---

## When Claude & LiteRouter Come Back Online

1. Get real API keys from:
   - Claude: https://console.anthropic.com/
   - LiteRouter: https://www.literouter.com/ (or your provider)

2. Replace the fake keys in `.env.local`:
   ```
   CLAUDE_KEY=sk-ant-your-real-key-here
   LITEROUTER_KEY=your-real-key-here
   ```

3. Restart the worker (kill Terminal 2, run `npm run dev` again)

4. Run the test again - now it'll call the REAL APIs!

---

## Testing LiteRouter Instead

Same thing, but different endpoint:

```powershell
$body = @{
    service = "literouter"
    endpoint = "/chat/completions"
    payload = @{
        model = "gpt-4"
        messages = @(@{role="user"; content="Say hello"})
    }
} | ConvertTo-Json

$response = Invoke-WebRequest -Uri "http://localhost:8787" `
  -Method POST `
  -Headers @{"Content-Type"="application/json"} `
  -Body $body

Write-Host $response.Content
```

---

## Troubleshooting

**"Connection refused"** → One of your terminals isn't running. Check all 3 are up.

**"Unauthorized" or API error** → That's fine! Means the worker is working, mock server got the request.

**"Worker not responding"** → Restart Terminal 2: kill with Ctrl+C, then `npm run dev` again.

**"Command not found: npm"** → You need to be in `c:\Users\aiden\opcode\worker` first: `cd c:\Users\aiden\opcode\worker`

---

## Next: Connect Your App

Once you confirm this works, read `INTEGRATION_GUIDE.md` to update your `renderer.js` to use the worker instead of calling APIs directly.
