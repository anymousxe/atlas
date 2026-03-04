# Claude API Key Setup

This file documents how to get your Claude API key for the Cloudflare Worker.

## Getting Your Claude API Key

1. Go to [Anthropic Console](https://console.anthropic.com/)
2. Log in or create an account
3. Navigate to **API Keys** section
4. Click **Create Key**
5. Give it a name (e.g., "Atlas IDE Worker")
6. Copy the key immediately (it won't be shown again)

## Using the Key

### Local Development

Create a `.env` file (Git-ignored) in the `worker/` folder:

```
CLAUDE_KEY=sk-ant-xxx...
LITEROUTER_KEY=sk-xxx...
```

Then run:

```bash
cd worker
npm run dev
```

Wrangler will automatically load these from `.env` for local testing.

### Production Deployment

Deploy the key to Cloudflare's vault:

```bash
cd worker
wrangler secret put CLAUDE_KEY --env production
```

Then paste your key when prompted. This encrypts it in Cloudflare's system.

Verify it was set:

```bash
wrangler secret list --env production
```

## Frontend Configuration

Update `src/renderer.js` or create a config that sets the worker URL:

```javascript
// For local development:
const WORKER_URL = 'http://localhost:8787';

// For production (after deployment):
const WORKER_URL = 'https://atlas-api-xyz.your-account.workers.dev';
```

## Security Checklist

- [ ] Claude API key added to `wrangler secret put` (not in code)
- [ ] LiteRouter key added to `wrangler secret put` (not in code)
- [ ] `.env` file added to `.gitignore` (don't commit local keys)
- [ ] Worker deployed with `npm run deploy`
- [ ] Frontend updated to use worker URL instead of direct API calls
- [ ] CORS configured in worker (restrict to your domain in production)
