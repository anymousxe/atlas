/**
 * worker-client.js — Utility to call the Cloudflare Worker API proxy
 * 
 * Usage:
 *   const result = await workerClient.call('claude', '/v1/messages', { model, messages });
 */
'use strict';

class WorkerClient {
  constructor(workerUrl = 'http://localhost:8787') {
    this.workerUrl = workerUrl;
  }

  /**
   * Make a proxied API call through the worker
   * @param {string} service - 'claude' or 'literouter'
   * @param {string} endpoint - API endpoint (e.g., '/v1/messages')
   * @param {object} payload - Request payload
   * @param {object} customHeaders - Optional custom headers to send to the API
   * @returns {Promise<Response | EventSource>} - Fetch response or EventSource for streaming
   */
  async call(service, endpoint, payload, customHeaders = {}) {
    const body = {
      service,
      endpoint,
      payload,
      headers: customHeaders
    };

    const response = await fetch(this.workerUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(`Worker error: ${error.error || response.statusText}`);
    }

    return response;
  }

  /**
   * Make a streaming API call through the worker
   * Yields events as they arrive
   */
  async* stream(service, endpoint, payload, customHeaders = {}) {
    const body = {
      service,
      endpoint,
      payload,
      headers: customHeaders
    };

    const response = await fetch(this.workerUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(`Worker error: ${error.error || response.statusText}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        
        // Split by lines and process SSE events
        const lines = chunk.split('\n');
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6);
            if (data === '[DONE]') break;
            try {
              yield JSON.parse(data);
            } catch (e) {
              console.warn('Failed to parse SSE event:', data);
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  /**
   * Set a new worker URL
   */
  setWorkerUrl(url) {
    this.workerUrl = url;
  }
}

const workerClient = new WorkerClient();

// Export for use in other modules
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { workerClient, WorkerClient };
}
