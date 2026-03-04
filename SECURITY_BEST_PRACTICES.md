# SECURITY GUIDELINES FOR API KEYS

## What NOT to do

❌ **Never commit your API keys to Git**
```javascript
// DON'T DO THIS:
const CLAUDE_KEY = 'sk-ant-xxx'; // Git will record this forever
const API = 'https://api.com?key=sk-ant-xxx'; // Exposed in URL
```

❌ **Never expose keys in frontend code**
```javascript
// DON'T DO THIS - visible in browser network tab:
fetch('https://api.com', {
  headers: { 'Authorization': 'Bearer ' + apiKey }
})
```

❌ **Never put keys in environment.json or config files that are tracked**
```json
{
  "apiKey": "sk-ant-xxx"  // Git will track this!
}
```

## What TO do

✅ **Use environment variables locally**
```bash
# worker/.env.local (Git-ignored)
CLAUDE_KEY=sk-ant-xxx
LITEROUTER_KEY=xxx
```

✅ **Use Cloudflare secrets for production**
```bash
wrangler secret put CLAUDE_KEY --env production
# Encrypted and stored in Cloudflare's vault
```

✅ **Use the Worker to hide keys from frontend**
```javascript
// Frontend never sees the key
const response = await fetch('worker-url', {
  body: JSON.stringify({ service: 'claude', endpoint: '...', payload: {...} })
});
```

## Checking if Keys are Exposed

Run these commands to check your Git history:

```bash
# Search Git history for "sk-ant" (Claude keys)
git log -S "sk-ant" --oneline

# Search for "CLAUDE_KEY=" in all files
git grep "CLAUDE_KEY="

# Check what's staged
git diff --cached
```

## If You Accidentally Committed a Key

**Act immediately:**

```bash
# 1. Revoke the old key (in the service's dashboard)
# (Can't be undone with code alone!)

# 2. Generate a new key

# 3. Update the worker secret:
wrangler secret put CLAUDE_KEY --env production

# 4. Remove from git history (advanced):
git filter-branch --tree-filter 'rm -f problematic-file' HEAD
# Or use BFG Repo-Cleaner (simpler)
```

## Files That Should NEVER Be Committed

Add to `.gitignore`:

```
.env                    # Local environment variables
.env.local              # Local overrides
.env.*.local            # Environment-specific locals
worker/.env.local       # Worker-specific local
worker/.env
*.key                   # Private keys
*.pem                   # Certificates
.secrets                # Any secrets folder
```

Check your `.gitignore` includes these before committing!

## Rotate Keys Regularly

Best practice: Change your API keys every 90 days

- Claude: https://console.anthropic.com/
- LiteRouter: https://www.literouter.com/ (or your provider)

Then update:
```bash
wrangler secret put CLAUDE_KEY --env production
```

## Monitor for Leaks

Services that scan for leaked credentials:
- GitHub's built-in secret scanning (automatically on public repos)
- GitGuardian (free): https://www.gitguardian.com/
- Truffle Hog: `pip install truffleHog`

---

## Summary: The Worker Solves All This

**Before Worker (Insecure):**
- Frontend has API key in code ❌
- Key visible in browser network tab ❌
- Key committed to Git history ❌
- Anyone who forks repo gets your key ❌

**After Worker (Secure):**
- Frontend has NO API key ✅
- Keys only in Cloudflare's vault ✅
- Keys never in Git ✅
- Forkers can't get your keys ✅
