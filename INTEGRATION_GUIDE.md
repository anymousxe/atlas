/**
 * INTEGRATION GUIDE: Using the Worker with Existing API Modules
 * 
 * This shows the MINIMAL changes needed to use the Cloudflare Worker
 * instead of calling APIs directly.
 */

/* ================================================================
   OPTION 1: Use worker-client.js (Recommended - Least Changes)
   ================================================================ */

// In renderer.js, at the top, import the worker client:
// const { workerClient } = require('./api/worker-client');

// Configure which worker to use:
// For local dev:
// workerClient.setWorkerUrl('http://localhost:8787');
// For production after deployment:
// workerClient.setWorkerUrl('https://atlas-api-abc123.your-account.workers.dev');

// Then wherever you make API calls, simply wrap them:

// BEFORE (Direct - key exposed):
// const response = await fetch('https://claude-gateway.rur.workers.dev/v1/messages', {
//   method: 'POST',
//   headers: { 'x-api-key': claudeKey, ... },
//   body: JSON.stringify(payload)
// });

// AFTER (Through worker - key hidden):
// const response = await workerClient.call(
//   'claude',
//   '/v1/messages',
//   payload  // No API key here!
// );

/* ================================================================
   OPTION 2: Update claude-api.js (Complete Integration)
   ================================================================ */

// Replace the function that makes the actual fetch call:

// async function callClaudeAPI(endpoint, payload, headers) {
//   // OLD CODE (keys in browser):
//   // const response = await fetch(CLAUDE_DIRECT_BASE + endpoint, {
//   //   method: 'POST',
//   //   headers: { 'x-api-key': claudeKey, ...headers },
//   //   body: JSON.stringify(payload)
//   // });

//   // NEW CODE (keys in Cloudflare):
//   const response = await workerClient.call(
//     'claude',
//     endpoint,
//     payload,
//     headers
//   );

//   return response;
// }

/* ================================================================
   OPTION 3: Handle Streaming Responses
   ================================================================ */

// For Claude's streaming mode:

// BEFORE (Direct streaming):
// const response = await fetch(CLAUDE_DIRECT_BASE + '/v1/messages', {
//   method: 'POST',
//   headers: { 'x-api-key': claudeKey, ... },
//   body: JSON.stringify({ ...payload, stream: true })
// });
// for await (const event of response.body) { ... }

// AFTER (Worker streaming):
// for await (const event of workerClient.stream(
//   'claude',
//   '/v1/messages',
//   { ...payload, stream: true }
// )) {
//   // event is already parsed JSON
//   console.log(event);
// }

/* ================================================================
   SETUP CHECKLIST
   ================================================================ */

// 1. [ ] Run: npm install in worker/ folder
// 2. [ ] Create worker/.env.local with your API keys
// 3. [ ] Run: npm run dev (in worker/ folder) to start worker locally
// 4. [ ] Import worker-client in renderer.js:
//        const { workerClient } = require('./api/worker-client');
// 5. [ ] Set worker URL in renderer.js:
//        workerClient.setWorkerUrl('http://localhost:8787');
// 6. [ ] Replace fetch() calls with workerClient.call()
// 7. [ ] Test your app - API calls should work, keys stay hidden
// 8. [ ] Deploy worker to production with npm run deploy
// 9. [ ] Update worker URL to production URL
// 10. [ ] Done! Your app now uses secure API proxy

/* ================================================================
   MINIMAL EXAMPLE: Updating renderer.js
   ================================================================ */

// At the TOP of renderer.js, add:
const { workerClient } = require('./api/worker-client');

// After loading your DOM or config, set the worker URL:
function initializeWorkerClient() {
  const isDev = process.env.NODE_ENV === 'development';
  const workerUrl = isDev 
    ? 'http://localhost:8787'
    : 'https://atlas-api-YOUR-ID.your-account.workers.dev';
  
  workerClient.setWorkerUrl(workerUrl);
  console.log('Worker client initialized with:', workerUrl);
}

// When you need to call Claude API, instead of:
// const response = await fetch(CLAUDE_DIRECT_BASE + '/v1/messages', {...})

// Do this:
// const response = await workerClient.call(
//   'claude',
//   '/v1/messages',
//   messagePayload
// );
// const data = await response.json();

/* ================================================================
   ERROR HANDLING
   ================================================================ */

// The worker client includes error handling:

async function callAPI() {
  try {
    const response = await workerClient.call('claude', '/v1/messages', payload);
    return await response.json();
  } catch (error) {
    console.error('API call failed:', error.message);
    // Handle error
  }
}

/* ================================================================
   DISABLE WORKER (FALLBACK TO DIRECT)
   ================================================================ */

// If you need to temporarily use direct API calls again:

const USE_WORKER = false; // Set to true for worker, false for direct

async function callAPI(service, endpoint, payload) {
  if (USE_WORKER) {
    // Use worker (no API key needed)
    return await workerClient.call(service, endpoint, payload);
  } else {
    // Use direct API (requires API key in code - not recommended!)
    // Your old code here...
  }
}

/* ================================================================
   DEPLOYMENT FLOW
   ================================================================ */

// Local Development:
//   1. worker/ folder running with npm run dev
//   2. renderer.js points to http://localhost:8787
//   3. API keys in worker/.env.local (Git-ignored)
//
// Production:
//   1. Run: wrangler secret put CLAUDE_KEY --env production
//   2. Run: wrangler secret put LITEROUTER_KEY --env production
//   3. Run: npm run deploy
//   4. Get URL like: https://atlas-api-abc123.your-account.workers.dev
//   5. Update renderer.js to use that URL
//   6. Deploy your app - now with secure API proxy!
