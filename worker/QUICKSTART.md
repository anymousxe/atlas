# Cloudflare Worker Setup

This folder contains your Cloudflare Worker that securely proxies API calls.

## Quick Commands

### Development
```bash
npm install
npm run dev
```
Runs locally at `http://localhost:8787`

### Production
```bash
wrangler login
wrangler secret put CLAUDE_KEY --env production
wrangler secret put LITEROUTER_KEY --env production
npm run deploy
```

## File Structure

- `wrangler.toml` - Worker configuration (environment URLs, etc.)
- `src/index.js` - The actual worker code that handles routing and secrets
- `package.json` - Dependencies
- `.env.example` - Template for local environment variables

## See Also

- `../WORKER_SETUP.md` - Complete setup guide
- `../API_KEY_SETUP.md` - How to get API keys
- `README.md` - Detailed documentation
