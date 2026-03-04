# CLOUDFLARE WORKER SETUP INSTRUCTIONS

## Quick Start (Local Development)

### Step 1: Install Dependencies

```bash
cd worker
npm install
```

### Step 2: Set Local API Keys

Create `worker/.env.local`:

```
CLAUDE_KEY=your-actual-claude-key-here
LITEROUTER_KEY=your-actual-literouter-key-here
```

Get keys from:
- Claude: https://console.anthropic.com/
- LiteRouter: https://www.literouter.com/

### Step 3: Start the Worker Locally

```bash
cd worker
npm run dev
```

Your worker will run at: `http://localhost:8787`

### Step 4: Test It Works

Open a terminal and test the worker:

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

---

## Production Deployment (Cloudflare)

### Step 1: Create Cloudflare Account

1. Go to https://dash.cloudflare.com/
2. Sign up if needed
3. Add a domain (or use the free subdomain workers.dev)

### Step 2: Login with Wrangler

```bash
cd worker
wrangler login
```

This opens a browser to authenticate and connect your local CLI to Cloudflare.

### Step 3: Store Secrets Safely

```bash
# Claude key (you'll paste it when prompted)
wrangler secret put CLAUDE_KEY --env production

# LiteRouter key
wrangler secret put LITEROUTER_KEY --env production
```

Verify they're stored:

```bash
wrangler secret list --env production
```

### Step 4: Deploy

```bash
cd worker
npm run deploy
```

You'll get a URL like: `https://atlas-api-abc123.your-account.workers.dev`

### Step 5: Update Frontend

In your Electron app, update the worker URL:

```javascript
// In renderer.js or your API modules
const WORKER_URL = 'https://atlas-api-abc123.your-account.workers.dev';
```

---

## How It Works Visually

```
┌─────────────────┐
│  Electron App   │
│  (Frontend)     │
└────────┬────────┘
         │
         │ POST /
         │ (no API keys in request!)
         │
         ▼
┌─────────────────────────────────┐
│  Cloudflare Worker              │
│  - Reads API key from vault     │
│  - Adds key to outgoing request │
│  - Proxies to real API          │
│  - Returns response             │
└────────┬────────────────────────┘
         │
         │ API request
         │ (WITH API key from vault!)
         │
         ▼
    ┌─────────────────┐
    │  Claude API     │
    │  LiteRouter     │
    │  (or others)    │
    └─────────────────┘
```

---

## Updating Your Frontend Code

### Before (Direct API Call - Keys Exposed)

```javascript
// ❌ DON'T DO THIS - API key visible in network tab!
const response = await fetch('https://claude-gateway.rur.workers.dev/v1/messages', {
  method: 'POST',
  headers: {
    'x-api-key': 'sk-ant-xxx', // EXPOSED IN BROWSER!
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    model: 'claude-opus-4-6',
    messages: [{ role: 'user', content: 'Hello' }]
  })
});
```

### After (Worker Proxy - Keys Hidden)

```javascript
// ✅ DO THIS - API key stays in Cloudflare vault
const response = await fetch('YOUR_WORKER_URL', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    service: 'claude',
    endpoint: '/v1/messages',
    payload: {
      model: 'claude-opus-4-6',
      messages: [{ role: 'user', content: 'Hello' }]
    }
  })
});
```

---

## Troubleshooting

### Worker won't start locally
```bash
# Clear cache
wrangler dev --env development --persist-to ./tmp
```

### "API key not configured" error
- Check `.env.local` exists in `worker/` folder
- Verify key format is correct
- Run `npm run dev` again

### Remote worker gives 502 error
```bash
# View live logs from deployed worker
wrangler tail --env production
```

### Tests fail with CORS errors
The worker includes CORS headers by default. For production, restrict:

In `worker/src/index.js`, change:
```javascript
'Access-Control-Allow-Origin': '*'
```
to:
```javascript
'Access-Control-Allow-Origin': 'https://your-domain.com'
```

---

## Files Created

```
worker/
├── wrangler.toml          # Worker configuration
├── package.json           # Dependencies
├── README.md              # Full documentation
└── src/
    └── index.js           # Worker code (handles routing & secrets)

src/api/
└── worker-client.js       # Utility to call the worker from frontend
```

---

## Next Steps

1. ✅ Set up `.env.local` with your API keys
2. ✅ Run `npm run dev` to test locally
3. ✅ Deploy with `npm run deploy`
4. ✅ Update frontend to use new worker URL
5. ✅ Test with your Electron app

Questions? See `worker/README.md` for detailed docs.
