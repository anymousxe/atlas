/**
 * Cloudflare Worker: Atlas API Proxy + Update Feed
 * 
 * POST /          — securely proxies API calls (Claude, LiteRouter)
 * GET  /update/*  — serves electron-updater feed (latest.yml, version info)
 * 
 * API keys + update metadata stored in Cloudflare secrets, NEVER exposed.
 */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return handleCORS();
    }

    // ── Update Feed (GET) ──────────────────────────────────────
    if (request.method === 'GET') {
      const path = url.pathname.replace(/\/+$/, '');

      if (path === '/update/latest.yml' || path === '/update/latest') {
        return handleLatestYml(env);
      }
      if (path === '/update/version') {
        return jsonResponse({ version: env.ATLAS_VERSION || '0.0.0' });
      }
      if (path === '/update/info') {
        return jsonResponse({
          version: env.ATLAS_VERSION || '0.0.0',
          exe: env.ATLAS_EXE_URL || null,
          zip: env.ATLAS_ZIP_URL || null,
        });
      }
      if (path === '/patreon/config') {
        // Return only the client ID (public) so the app can build the OAuth URL
        return jsonResponse({ client_id: env.PATREON_CLIENT_ID || '' });
      }
      if (path === '/health' || path === '/') {
        return jsonResponse({ status: 'ok', service: 'atlas-api-proxy' });
      }
      return errorResponse('Not found', 404);
    }

    // ── API Proxy (POST) ───────────────────────────────────────
    if (request.method !== 'POST') {
      return errorResponse('Method not allowed. Use POST.', 405);
    }

    // ── Patreon Verify (POST) ──────────────────────────────────
    if (url.pathname === '/patreon/verify') {
      return handlePatreonVerify(request, env);
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
 * Helper: Generate latest.yml for electron-updater generic provider
 * electron-updater expects YAML with: version, files[], path, sha512, releaseDate
 */
function handleLatestYml(env) {
  const version = (env.ATLAS_VERSION || '0.0.0').trim();
  const exeUrl = (env.ATLAS_EXE_URL || '').trim();
  const zipUrl = (env.ATLAS_ZIP_URL || '').trim();
  const sha512 = (env.ATLAS_EXE_SHA512 || '').trim();
  const size = (env.ATLAS_EXE_SIZE || '0').trim();
  const releaseDate = (env.ATLAS_RELEASE_DATE || new Date().toISOString()).trim();

  if (!version || version === '0.0.0') {
    return errorResponse('Update feed not configured yet (ATLAS_VERSION not set)', 404);
  }

  const exeFilename = `Atlas-Setup-${version}.exe`;

  // electron-updater latest.yml format
  const yml = [
    `version: ${version}`,
    `files:`,
    `  - url: ${exeUrl || exeFilename}`,
    `    sha512: ${sha512 || ''}`,
    `    size: ${size}`,
    `path: ${exeUrl || exeFilename}`,
    `sha512: ${sha512 || ''}`,
    `releaseDate: '${releaseDate}'`,
  ].join('\n');

  return new Response(yml, {
    status: 200,
    headers: {
      'Content-Type': 'application/x-yaml',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      ...getCORSHeaders(),
    },
  });
}

/**
 * Handle Patreon OAuth verification
 * 1. Exchange auth code for user access token
 * 2. Get user identity (Patreon user ID)
 * 3. Use Creator token to check campaign membership + tier
 */
async function handlePatreonVerify(request, env) {
  try {
    const body = await request.json().catch(() => ({}));
    const { code, redirect_uri } = body;
    if (!code || !redirect_uri) {
      return errorResponse('Missing code or redirect_uri', 400);
    }

    const clientId = (env.PATREON_CLIENT_ID || '').trim();
    const clientSecret = (env.PATREON_CLIENT_SECRET || '').trim();
    const creatorToken = (env.PATREON_CREATOR_TOKEN || '').trim();
    if (!clientId || !clientSecret || !creatorToken) {
      return errorResponse('Patreon not configured on server', 500);
    }

    // Step 1: Exchange code for user access token
    const tokenRes = await fetch('https://www.patreon.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        grant_type: 'authorization_code',
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri,
      }).toString(),
    });
    const tokenData = await tokenRes.json().catch(() => ({}));
    if (!tokenRes.ok || !tokenData.access_token) {
      return jsonResponse({ verified: false, reason: tokenData.error || 'Token exchange failed' }, 200);
    }

    // Step 2: Get user identity
    const identityRes = await fetch('https://www.patreon.com/api/oauth2/v2/identity?fields%5Buser%5D=email,full_name', {
      headers: { 'Authorization': `Bearer ${tokenData.access_token}` },
    });
    const identityData = await identityRes.json().catch(() => ({}));
    const patreonUserId = identityData?.data?.id;
    const userEmail = identityData?.data?.attributes?.email || '';
    const userName = identityData?.data?.attributes?.full_name || '';
    if (!patreonUserId) {
      return jsonResponse({ verified: false, reason: 'Could not get Patreon identity' }, 200);
    }

    // Step 3: Get campaign ID
    const campaignRes = await fetch('https://www.patreon.com/api/oauth2/v2/campaigns', {
      headers: { 'Authorization': `Bearer ${creatorToken}` },
    });
    const campaignData = await campaignRes.json().catch(() => ({}));
    const campaignId = campaignData?.data?.[0]?.id;
    if (!campaignId) {
      return jsonResponse({ verified: false, reason: 'Campaign not found' }, 200);
    }

    // Step 4: Search for this user in campaign members
    let tier = null;
    let cursor = null;
    const memberFields = 'fields%5Bmember%5D=patron_status,currently_entitled_amount_cents,email';
    for (let page = 0; page < 20; page++) {
      let membersUrl = `https://www.patreon.com/api/oauth2/v2/campaigns/${campaignId}/members?${memberFields}&page%5Bcount%5D=100`;
      if (cursor) membersUrl += `&page%5Bcursor%5D=${encodeURIComponent(cursor)}`;

      const membersRes = await fetch(membersUrl, {
        headers: { 'Authorization': `Bearer ${creatorToken}` },
      });
      const membersData = await membersRes.json().catch(() => ({}));
      const members = membersData?.data || [];

      for (const m of members) {
        const mUserId = m?.relationships?.user?.data?.id;
        const mEmail = (m?.attributes?.email || '').toLowerCase();
        if (mUserId === patreonUserId || (userEmail && mEmail === userEmail.toLowerCase())) {
          const status = m?.attributes?.patron_status;
          const cents = m?.attributes?.currently_entitled_amount_cents || 0;
          if (status === 'active_patron' && cents > 0) {
            if (cents >= 2000) tier = 'dev';
            else if (cents >= 1000) tier = 'pro';
            else tier = 'pro'; // any active patron gets at least pro
          }
          break;
        }
      }

      if (tier !== null) break;
      cursor = membersData?.meta?.pagination?.cursors?.next;
      if (!cursor) break;
    }

    if (tier) {
      return jsonResponse({ verified: true, tier, email: userEmail, name: userName });
    }
    return jsonResponse({ verified: false, reason: 'No active Patreon membership found. Make sure you have an active pledge.', email: userEmail });
  } catch (err) {
    console.error('Patreon verify error:', err);
    return errorResponse('Patreon verification failed: ' + err.message, 500);
  }
}

/**
 * Helper: Get CORS headers to allow requests from your frontend
 */
function getCORSHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
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
