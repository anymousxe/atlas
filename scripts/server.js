const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const morgan = require('morgan');
const bodyParser = require('body-parser');

// Initialize server
dotenv.config();
const app = express();
const PORT = process.env.BACKEND_PORT || 6969;

// Middleware
app.use(cors());
app.use(morgan('dev'));
app.use(bodyParser.json());

// Secure API keys (stored only on server)
const CLAUDE_API_KEY = (process.env.CLAUDE_API_KEY || '').trim();
const LITEROUTER_KEY = (process.env.LITEROUTER_KEY || '').trim();

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok' }));

// ─── CLAUDE PROXY ───────────────────────────────────────────
app.post('/api/claude/messages', async (req, res) => {
  if (!CLAUDE_API_KEY) return res.status(500).json({ error: 'Claude key not configured on backend.' });
  
  try {
    const response = await fetch('https://claude-gateway.rur.workers.dev/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': CLAUDE_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      body: JSON.stringify(req.body)
    });

    if (req.body.stream) {
      // Stream handling
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      
      const reader = response.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(value);
      }
      res.end();
    } else {
      const data = await response.json();
      res.status(response.status).json(data);
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── LITEROUTER PROXY ───────────────────────────────────────
app.post('/api/literouter/chat/completions', async (req, res) => {
  if (!LITEROUTER_KEY) return res.status(500).json({ error: 'LiteRouter key not configured on backend.' });

  try {
    const response = await fetch('https://api.literouter.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${LITEROUTER_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(req.body)
    });

    if (req.body.stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      const reader = response.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(value);
      }
      res.end();
    } else {
      const data = await response.json();
      res.status(response.status).json(data);
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => console.log(`[Backend] Running on http://localhost:${PORT}`));
