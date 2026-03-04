/**
 * Cloudflare Worker: Atlas API Proxy
 * 
 * This worker securely proxies API calls from your frontend to external APIs.
 * API keys are stored in Cloudflare's secure vault and NEVER exposed to the browser.
 * 
 * CORS is enabled to allow requests from your Electron app frontend.
 */

export default {
  async fetch(request, env, ctx) {
    // Only allow POST and OPTIONS requests
    if (request.method === 'OPTIONS') {
      return handleCORS();
    }

    if (request.method !== 'POST') {
      return errorResponse('Method not allowed. Use POST.', 405);
    }

    try {
      // Parse the incoming request body
      let body;
      try {
        body = await request.json();
      } catch (e) {
        return errorResponse('Invalid JSON body', 400);
      }

      const { service, endpoint, payload, headers: customHeaders } = body;

      // Validate required fields
      if (!service || !endpoint || !payload) {
        return errorResponse('Missing required fields: service, endpoint, payload', 400);
      }

      // Route to the appropriate API handler
      switch (service.toLowerCase()) {
        case 'claude':
          return handleClaudeAPI(endpoint, payload, customHeaders, env);

        case 'literouter':
          return handleLiteRouterAPI(endpoint, payload, customHeaders, env);

        default:
          return errorResponse(`Unknown service: ${service}`, 400);
      }
    } catch (error) {
      console.error('Worker error:', error);
      return errorResponse(`Server error: ${error.message}`, 500);
    }
  }
};

/**
 * Handle Claude API requests
 * Adds the Claude API key from environment secrets to the request
 */
async function handleClaudeAPI(endpoint, payload, customHeaders = {}, env) {
  // Use local mock API if CLAUDE_API_KEY starts with 'test-' (development)
  const isMock = env.CLAUDE_API_KEY?.startsWith('test-');
  const baseURL = isMock 
    ? 'http://localhost:6969/api/claude'
    : (env.CLAUDE_BASE_URL || 'https://claude-gateway.rur.workers.dev');
  const apiKey = env.CLAUDE_API_KEY;

  if (!apiKey) {
    return errorResponse('Claude API key not configured', 500);
  }

  const url = `${baseURL}${endpoint.startsWith('/') ? '' : '/'}${endpoint}`;

  const headers = {
    'Content-Type': 'application/json',
    'x-api-key': apiKey,
    ...customHeaders,
  };

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });

    // Stream responses if they're streaming
    if (response.headers.get('content-type')?.includes('text/event-stream')) {
      return new Response(response.body, {
        status: response.status,
        headers: {
          'Content-Type': response.headers.get('content-type'),
          ...getCORSHeaders(),
        },
      });
    }

    // Return JSON responses
    const data = await response.json();
    return jsonResponse(data, response.status);
  } catch (error) {
    console.error('Claude API error:', error);
    return errorResponse(`Claude API error: ${error.message}`, 502);
  }
}

/**
 * Handle LiteRouter API requests
 * Adds the LiteRouter API key from environment secrets to the request
 */
async function handleLiteRouterAPI(endpoint, payload, customHeaders = {}, env) {
  // Use local mock API if LITEROUTER_KEY_1 starts with 'test-' (development)
  const isMock = env.LITEROUTER_KEY_1?.startsWith('test-');
  const baseURL = isMock
    ? 'http://localhost:6969/api/literouter'
    : (env.LITEROUTER_BASE_URL || 'https://api.literouter.com/v1');
  const apiKey = env.LITEROUTER_KEY_1;

  if (!apiKey) {
    return errorResponse('LiteRouter API key not configured', 500);
  }

  const url = `${baseURL}${endpoint.startsWith('/') ? '' : '/'}${endpoint}`;

  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${apiKey}`,
    ...customHeaders,
  };

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });

    // Stream responses if they're streaming
    if (response.headers.get('content-type')?.includes('text/event-stream')) {
      return new Response(response.body, {
        status: response.status,
        headers: {
          'Content-Type': response.headers.get('content-type'),
          ...getCORSHeaders(),
        },
      });
    }

    // Return JSON responses
    const data = await response.json();
    return jsonResponse(data, response.status);
  } catch (error) {
    console.error('LiteRouter API error:', error);
    return errorResponse(`LiteRouter API error: ${error.message}`, 502);
  }
}

/**
 * Helper: Get CORS headers to allow requests from your frontend
 */
function getCORSHeaders() {
  return {
    'Access-Control-Allow-Origin': '*', // In production, restrict to your domain
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
  };
}

/**
 * Helper: Handle CORS preflight requests
 */
function handleCORS() {
  return new Response(null, {
    status: 204,
    headers: getCORSHeaders(),
  });
}

/**
 * Helper: Return JSON response with CORS headers
 */
function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...getCORSHeaders(),
    },
  });
}

/**
 * Helper: Return error response
 */
function errorResponse(message, status = 500) {
  return jsonResponse({ error: message }, status);
}
