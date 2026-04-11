/**
 * Network capture - fetch, XHR, and http/https module interception
 */

import type { Transport, CaptureModule, Config } from '../types';
import { detectRuntime, getCapabilities } from '../runtime';

let requestId = 0;
function generateRequestId(): string {
  return `req_${Date.now()}_${requestId++}`;
}

/**
 * Truncate body if it exceeds max size
 */
function truncateBody(body: unknown, maxSize: number): unknown {
  if (body === null || body === undefined) return body;
  
  if (typeof body === 'string') {
    if (body.length > maxSize) {
      return body.slice(0, maxSize) + `... [truncated, ${body.length} total]`;
    }
    return body;
  }
  
  if (body instanceof ArrayBuffer || (typeof Buffer !== 'undefined' && Buffer.isBuffer(body))) {
    const size = body instanceof ArrayBuffer ? body.byteLength : (body as Buffer).length;
    if (size > maxSize) {
      return `[Binary data: ${size} bytes, truncated]`;
    }
    return `[Binary data: ${size} bytes]`;
  }
  
  // For objects, serialize and check size
  try {
    const str = JSON.stringify(body);
    if (str.length > maxSize) {
      return JSON.parse(str.slice(0, maxSize)) + `... [truncated]`;
    }
    return body;
  } catch {
    return String(body);
  }
}

/**
 * Convert Headers to plain object
 */
function headersToObject(headers: Headers | Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  
  if (headers instanceof Headers) {
    headers.forEach((value, key) => {
      result[key] = value;
    });
  } else if (headers && typeof headers === 'object') {
    Object.assign(result, headers);
  }
  
  return result;
}

/**
 * Try to parse response body
 */
async function parseBody(response: Response, maxSize: number): Promise<unknown> {
  const contentType = response.headers.get('content-type') || '';
  
  try {
    // Clone the response so we don't consume it
    const clone = response.clone();
    
    if (contentType.includes('application/json')) {
      const text = await clone.text();
      return truncateBody(JSON.parse(text), maxSize);
    }
    
    if (contentType.includes('text/')) {
      const text = await clone.text();
      return truncateBody(text, maxSize);
    }
    
    // Binary data
    const buffer = await clone.arrayBuffer();
    return truncateBody(buffer, maxSize);
  } catch {
    return '[Could not read body]';
  }
}

/**
 * Capture fetch requests
 */
function captureFetch(transport: Transport, config: Config): () => void {
  const originalFetch = globalThis.fetch;
  if (!originalFetch) return () => {};
  
  const sidetrackEndpoint = config.endpoint;
  
  const wrappedFetch = async function (input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    
    // Don't capture requests to sidetrack itself
    if (url.startsWith(sidetrackEndpoint)) {
      return originalFetch(input, init);
    }
    
    const id = generateRequestId();
    const startTime = Date.now();
    const method = init?.method || (typeof input === 'object' && 'method' in input ? input.method : 'GET');
    
    // Capture request
    transport.send({
      _type: 'fetch.request',
      id,
      url,
      method: method.toUpperCase(),
      headers: config.network.captureHeaders ? headersToObject(init?.headers as any || {}) : undefined,
      body: init?.body ? truncateBody(init.body, config.network.maxBodySize) : undefined,
    });
    
    try {
      const response = await originalFetch(input, init);
      const durationMs = Date.now() - startTime;
      
      // Capture response
      const body = await parseBody(response, config.network.maxBodySize);
      
      transport.send({
        _type: 'fetch.response',
        id,
        url,
        status: response.status,
        statusText: response.statusText,
        headers: config.network.captureHeaders ? headersToObject(response.headers) : undefined,
        body,
        durationMs,
      });
      
      return response;
    } catch (err) {
      const durationMs = Date.now() - startTime;
      
      transport.send({
        _type: 'fetch.error',
        id,
        url,
        error: err instanceof Error ? err.message : String(err),
        durationMs,
      });
      
      throw err;
    }
  };
  
  (globalThis as any).fetch = wrappedFetch;
  
  return () => {
    (globalThis as any).fetch = originalFetch;
  };
}

/**
 * Capture XHR requests (browser only)
 */
function captureXHR(transport: Transport, config: Config): () => void {
  if (typeof XMLHttpRequest === 'undefined') return () => {};
  
  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;
  const originalSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;
  
  const sidetrackEndpoint = config.endpoint;
  
  (XMLHttpRequest.prototype as any).open = function (method: string, url: string | URL, async?: boolean, username?: string | null, password?: string | null) {
    (this as any).__sidetrack_method = method;
    (this as any).__sidetrack_url = typeof url === 'string' ? url : url.href;
    (this as any).__sidetrack_headers = {};
    return originalOpen.call(this, method, url, async ?? true, username, password);
  };
  
  XMLHttpRequest.prototype.setRequestHeader = function (name: string, value: string) {
    if ((this as any).__sidetrack_headers) {
      (this as any).__sidetrack_headers[name] = value;
    }
    return originalSetRequestHeader.call(this, name, value);
  };
  
  (XMLHttpRequest.prototype as any).send = function (body?: Document | XMLHttpRequestBodyInit | null) {
    const url = (this as any).__sidetrack_url;
    
    // Don't capture requests to sidetrack itself
    if (url?.startsWith(sidetrackEndpoint)) {
      return originalSend.call(this, body);
    }
    
    const id = generateRequestId();
    const startTime = Date.now();
    
    // Capture request
    transport.send({
      _type: 'xhr.request',
      id,
      url: url || '',
      method: ((this as any).__sidetrack_method || 'GET').toUpperCase(),
      headers: config.network.captureHeaders ? (this as any).__sidetrack_headers : undefined,
      body: body ? truncateBody(body, config.network.maxBodySize) : undefined,
    });
    
    this.addEventListener('load', () => {
      const durationMs = Date.now() - startTime;
      
      let responseBody: unknown;
      try {
        if (this.responseType === '' || this.responseType === 'text') {
          responseBody = truncateBody(this.responseText, config.network.maxBodySize);
        } else if (this.responseType === 'json') {
          responseBody = truncateBody(this.response, config.network.maxBodySize);
        } else {
          responseBody = `[${this.responseType} response]`;
        }
      } catch {
        responseBody = '[Could not read response]';
      }
      
      transport.send({
        _type: 'xhr.response',
        id,
        url: url || '',
        status: this.status,
        statusText: this.statusText,
        body: responseBody,
        durationMs,
      });
    });
    
    this.addEventListener('error', () => {
      const durationMs = Date.now() - startTime;
      transport.send({
        _type: 'xhr.error',
        id,
        url: url || '',
        error: 'XHR error',
        durationMs,
      });
    });
    
    return originalSend.call(this, body);
  };
  
  return () => {
    (XMLHttpRequest.prototype as any).open = originalOpen;
    (XMLHttpRequest.prototype as any).send = originalSend;
    XMLHttpRequest.prototype.setRequestHeader = originalSetRequestHeader;
  };
}

/**
 * Capture http/https module requests (Node/Bun)
 */
function captureHttp(transport: Transport, config: Config): () => void {
  const runtime = detectRuntime();
  if (runtime !== 'node' && runtime !== 'bun') return () => {};
  
  // Dynamic import for Node modules
  let http: any;
  let https: any;
  
  try {
    http = require('http');
    https = require('https');
  } catch {
    return () => {};
  }
  
  const sidetrackEndpoint = config.endpoint;
  const originalHttpRequest = http.request;
  const originalHttpsRequest = https.request;
  
  function wrapRequest(original: Function, protocol: string) {
    return function (this: any, ...args: any[]) {
      let options: any;
      let callback: Function | undefined;
      
      // Parse arguments (url, options, callback) or (options, callback)
      if (typeof args[0] === 'string' || args[0] instanceof URL) {
        options = typeof args[1] === 'object' ? args[1] : {};
        options.url = args[0].toString();
        callback = typeof args[1] === 'function' ? args[1] : args[2];
      } else {
        options = args[0] || {};
        callback = args[1];
      }
      
      const url = options.url || `${protocol}://${options.hostname || options.host || 'localhost'}${options.path || '/'}`;
      
      // Don't capture requests to sidetrack itself
      if (url.startsWith(sidetrackEndpoint)) {
        return original.apply(this, args);
      }
      
      const id = generateRequestId();
      const startTime = Date.now();
      const method = (options.method || 'GET').toUpperCase();
      
      // Capture request
      transport.send({
        _type: 'http.request',
        id,
        url,
        method,
        headers: config.network.captureHeaders ? options.headers : undefined,
      });
      
      const req = original.apply(this, args);
      
      // Capture request body
      const originalWrite = req.write.bind(req);
      let requestBody = '';
      req.write = function (chunk: any, ...writeArgs: any[]) {
        if (chunk) {
          requestBody += chunk.toString();
        }
        return originalWrite(chunk, ...writeArgs);
      };
      
      req.on('response', (res: any) => {
        let responseBody = '';
        
        res.on('data', (chunk: any) => {
          responseBody += chunk.toString();
        });
        
        res.on('end', () => {
          const durationMs = Date.now() - startTime;
          
          transport.send({
            _type: 'http.response',
            id,
            url,
            status: res.statusCode,
            statusText: res.statusMessage,
            headers: config.network.captureHeaders ? res.headers : undefined,
            body: truncateBody(responseBody, config.network.maxBodySize),
            durationMs,
          });
        });
      });
      
      req.on('error', (err: Error) => {
        const durationMs = Date.now() - startTime;
        transport.send({
          _type: 'http.error',
          id,
          url,
          error: err.message,
          durationMs,
        });
      });
      
      return req;
    };
  }
  
  http.request = wrapRequest(originalHttpRequest, 'http');
  https.request = wrapRequest(originalHttpsRequest, 'https');
  
  return () => {
    http.request = originalHttpRequest;
    https.request = originalHttpsRequest;
  };
}

export function captureNetwork(transport: Transport, config: Config): CaptureModule {
  const caps = getCapabilities();
  const cleanupFns: Array<() => void> = [];
  
  if (caps.fetch) {
    cleanupFns.push(captureFetch(transport, config));
  }
  
  if (caps.xhr) {
    cleanupFns.push(captureXHR(transport, config));
  }
  
  if (caps.httpModule) {
    cleanupFns.push(captureHttp(transport, config));
  }
  
  return {
    destroy() {
      for (const fn of cleanupFns) {
        fn();
      }
    },
  };
}
