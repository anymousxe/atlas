/**
 * Mock API Server for Testing
 * 
 * Run this to test the worker without needing real APIs
 * 
 * Usage:
 *   node scripts/mock-api.js
 * 
 * Then make requests to http://localhost:6969/api/claude or /api/literouter
 */

const http = require('http');
const url = require('url');

const PORT = 6969;

const server = http.createServer((req, res) => {
  // Enable CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-api-key');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;

  // Claude API mock
  if (pathname === '/api/claude/v1/messages' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      console.log('✅ Claude API called with:', body.slice(0, 100) + '...');
      
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id: 'msg_test123',
        type: 'message',
        role: 'assistant',
        content: [
          {
            type: 'text',
            text: 'Hello! I\'m a mock API response. The real Claude API is currently down, but your worker is working correctly! When Claude comes back online, replace the test key in .env.local with your real one and this will actually call Claude.'
          }
        ],
        model: 'claude-opus-4-6',
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 50 }
      }));
    });
    return;
  }

  // LiteRouter API mock
  if (pathname === '/api/literouter/chat/completions' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      console.log('✅ LiteRouter API called with:', body.slice(0, 100) + '...');
      
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id: 'chatcmpl-test123',
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: 'gpt-4',
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: 'Hello! I\'m a mock LiteRouter response. Your worker is working! When LiteRouter comes back online, use your real key for actual responses.'
            },
            finish_reason: 'stop'
          }
        ],
        usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 }
      }));
    });
    return;
  }

  // Health check
  if (pathname === '/health' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', mocks: ['claude', 'literouter'] }));
    return;
  }

  // 404
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT, () => {
  console.log(`
🎭 Mock API Server Running
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  📍 http://localhost:6969

  Available endpoints:
    • POST http://localhost:6969/api/claude/v1/messages
    • POST http://localhost:6969/api/literouter/chat/completions
    • GET  http://localhost:6969/health

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  This simulates the real APIs so you can test
  your worker without needing Claude/LiteRouter
  to be online.

  In another terminal, run:
    cd worker
    npm run dev

  Then test with the commands in SIMPLE_GUIDE.md

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  `);
});
