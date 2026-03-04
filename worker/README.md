# Atlas API Proxy Worker

This is a Cloudflare Worker that securely proxies API calls from the Atlas IDE frontend to external services like Claude and LiteRouter.

## Why This Exists

**Problem:** If your frontend calls APIs directly, the API key is visible in:
- Browser network inspector
- Your app's JavaScript bundle
- Any JavaScript that runs in the browser

**Solution:** The Worker sits in the middle:
1. Frontend sends requests to the Worker (no API key in the request)
2. Worker retrieves the API key from Cloudflare's secure vault
3. Worker adds the key and calls the real API
4. Worker returns the response to the frontend
5. The API key never touches the browser

## Setup

### 1. Install Dependencies

```bash
cd worker
npm install
```

### 2. Set Up Local API Keys (Development)

Create a `.env.local` file in the `worker/` directory:

```
CLAUDE_KEY=your-actual-claude-key
LITEROUTER_KEY=your-actual-literouter-key
```

Then when running locally:

```bash
npm run dev
```

The worker will run at `http://localhost:8787`

### 3. Deploy to Cloudflare (Production)

First, set up your secrets on Cloudflare:

```bash
# This will prompt you to paste your Claude API key
wrangler secret put CLAUDE_KEY --env production

# This will prompt you to paste your LiteRouter API key
wrangler secret put LITEROUTER_KEY --env production
```

Then deploy:

```bash
npm run deploy
```

You'll get a URL like: `https://atlas-api-xyz.your-account.workers.dev`

## How to Use from Frontend

Instead of calling the API directly:

```javascript
// ❌ BEFORE: API key exposed in the request
const response = await fetch('https://claude-gateway.rur.workers.dev/v1/messages', {
  method: 'POST',
  headers: {
    'x-api-key': 'your-secret-key', // EXPOSED!
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({ model: 'claude-opus-4-6', ... })
});
```

```javascript
// ✅ AFTER: API key hidden in the Worker
const response = await fetch('https://your-worker-url.workers.dev/', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    service: 'claude',
    endpoint: '/v1/messages',
    payload: { model: 'claude-opus-4-6', ... }
  })
});
```

### Example: Claude API Call

```javascript
const response = await fetch('YOUR_WORKER_URL', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    service: 'claude',
    endpoint: '/v1/messages',
    payload: {
      model: 'claude-opus-4-6',
      max_tokens: 2048,
      messages: [{ role: 'user', content: 'Hello!' }]
    }
  })
});

const data = await response.json();
console.log(data);
```

### Example: LiteRouter API Call

```javascript
const response = await fetch('YOUR_WORKER_URL', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    service: 'literouter',
    endpoint: '/chat/completions',
    payload: {
      model: 'gpt-4',
      messages: [{ role: 'user', content: 'Hello!' }]
    }
  })
});

const data = await response.json();
console.log(data);
```

## Configuration

Edit `wrangler.toml` to:
- Change environment variables (API base URLs)
- Set your Cloudflare domain
- Configure CORS settings

## Debugging

View real-time logs from your deployed worker:

```bash
wrangler tail --env production
```

## Security Notes

1. **API Keys:** Stored securely in Cloudflare's vault, never in code
2. **CORS:** Currently set to `*` (all origins). In production, restrict to your domain:
   ```javascript
   'Access-Control-Allow-Origin': 'https://your-domain.com'
   ```
3. **Rate Limiting:** Consider adding rate limiting in the worker to prevent abuse
4. **Monitoring:** Use Cloudflare's dashboard to monitor worker usage and errors
