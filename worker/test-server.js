/**
 * Simple direct test of the worker code without wrangler
 * This avoids all wrangler dev complexity
 */

import http from 'http';
import workerModule from './src/index.js';

const worker = workerModule;
const PORT = 8787;

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end();
    return;
  }

  if (req.method !== 'POST') {
    res.writeHead(405, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Method not allowed' }));
    return;
  }

  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', async () => {
    try {
      const request = {
        method: req.method,
        url: req.url,
        json: async () => JSON.parse(body)
      };

      const env = {
        CLAUDE_KEY: process.env.CLAUDE_KEY || 'test-key-123',
        LITEROUTER_KEY: process.env.LITEROUTER_KEY || 'test-key-456',
        CLAUDE_BASE_URL: 'https://claude-gateway.rur.workers.dev',
        LITEROUTER_BASE_URL: 'https://api.literouter.com/v1'
      };

      console.log('📍 Request received:', request.method, request.url);
      console.log('� Raw body:', body.slice(0, 100));
      console.log('📦 Env keys:', Object.keys(env));
      
      const parsedBody = JSON.parse(body);
      console.log('✅ Parsed JSON:', JSON.stringify(parsedBody).slice(0, 100));
      
      const response = await worker.fetch(request, env);
      const responseText = await response.text();

      console.log('✅ Response:', response.status);
      
      res.writeHead(response.status, {
        'Content-Type': response.headers.get('content-type') || 'application/json',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(responseText);
    } catch (error) {
      console.error('❌ Error:', error);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message }));
    }
  });
});

server.listen(PORT, () => {
  console.log(`
  ✅ Test Server Ready
  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  📍 http://localhost:${PORT}
  
  Env vars loaded:
  • CLAUDE_KEY: test-key-123 (from .env.local)
  • LITEROUTER_KEY: test-key-456 (from .env.local)
  
  Make a POST request to /
  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`);
});
