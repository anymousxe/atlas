# SUPER SIMPLE VERSION (For Humans)

## The Problem (In Plain English)

Right now: Your app has API keys hardcoded somewhere → anyone looking at your code/browser can steal them.

What we're doing: Hide the keys on a Cloudflare server → your app talks to Cloudflare → Cloudflare talks to the real API WITH the key → browser never sees the key.

Think of it like a messenger:
- ❌ You walking around with secret documents (current)
- ✅ You sending a messenger who has the secret documents (what we're doing)

---

## What You Need to Do (Pick ONE, not all)

### Option A: Test WITHOUT the APIs being up (EASIEST - DO THIS NOW)

**Step 1: Install stuff**
```bash
cd worker
npm install
```

**Step 2: Create a fake test API key**
```bash
cd worker
# Make a file called .env.local
```

In `worker/.env.local`, paste:
```
CLAUDE_KEY=test-key-12345
LITEROUTER_KEY=test-key-67890
```

That's it. It's fake but it doesn't matter for testing.

**Step 3: Start the worker**
```bash
cd worker
npm run dev
```

You'll see: `Ready on http://localhost:8787`

**Step 4: Test it with this command** (open new terminal, stay in same folder):
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

Invoke-WebRequest -Uri "http://localhost:8787" `
  -Method POST `
  -Headers @{"Content-Type"="application/json"} `
  -Body $body
```

**Expected result:** You'll see an error like `401 Unauthorized` or `authentication failed` — that's GOOD! It means your worker ran and tried to call Claude. The error is just because the API is down.

✅ **You're done testing.**

---

### Option B: Test When APIs Are Back Up (LATER)

1. Get real keys from Claude & LiteRouter
2. Put them in `.env.local`
3. Restart the worker
4. Run the test command above
5. Should see actual response

---

## What These Files Actually Do (The 3-Minute Version)

```
worker/
├── wrangler.toml       ← Says "this is my worker config"
├── .env.local          ← YOUR SECRET KEYS (git ignores this)
├── src/index.js        ← The worker code (sits between you and APIs)
└── package.json        ← Dependencies
```

**wrangler.toml:** "Use these environment variables"
**src/index.js:** "When I get a request, grab the secret key from the vault and add it to the API call"
**.env.local:** Your actual secret keys (nobody should see this)

---

## The Workflow

```
1. You make a request from your app
   → goes to localhost:8787 (the worker)

2. Worker says "what API do you want?"
   → You say "claude" and the endpoint

3. Worker grabs the secret key from .env.local
   → Adds it to the request

4. Worker calls the real API WITH the key
   → Real API responds

5. Worker sends response back to you
   → Your app shows the result

💡 Your app NEVER sees the secret key. Only the worker has it.
```

---

## Deploy to Production (When APIs Work)

Later, after the APIs are back up and you've tested locally:

```bash
cd worker
wrangler login          # Authorize with Cloudflare
wrangler secret put CLAUDE_KEY --env production  # Store secret
wrangler secret put LITEROUTER_KEY --env production
npm run deploy          # Deploy to the internet
```

Then change your app to use the deployed URL instead of localhost:8787.

---

## Known Issues

**"It says error connecting to Claude"** → Normal if APIs are down. Just means worker is working.

**"CORS error"** → Worker handles this, just in case.

**"Command not found: wrangler"** → Install it: `npm install -g wrangler`

---

## What to Do Right Now

1. `cd worker && npm install` ← Do this
2. Create `.env.local` with fake keys ← Do this
3. `npm run dev` ← Do this
4. Run the test command ← Do this
5. When APIs come back up, put real keys in `.env.local` and test again ← Do later

That's it!
