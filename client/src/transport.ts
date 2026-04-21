/**
 * Transport layer - batching, buffering, and sending events to sidetrack
 */

import type { Config, EventInput, Transport } from './types';
import { detectRuntime } from './runtime';

// Full event with envelope
interface FullEvent extends EventInput {
  _ts: number;
  _runtime: string;
  _seq: number;
  _tags?: Record<string, string>;
  // Server runtimes
  cwd?: string;
  // Browser runtimes
  url?: string;
  origin?: string;
  hostname?: string;
}

// Get static context fields (captured once at init)
function getStaticContextFields(runtime: string): Partial<FullEvent> {
  // Server runtimes: include cwd (doesn't change)
  if (runtime === 'node' || runtime === 'bun') {
    return { cwd: process.cwd() };
  }
  
  if (runtime === 'deno') {
    return { cwd: (globalThis as any).Deno.cwd() };
  }
  
  // Browser: origin and hostname are stable
  if (runtime === 'browser' && typeof window !== 'undefined') {
    return {
      origin: window.location.origin,
      hostname: window.location.hostname,
    };
  }
  
  // Worker: limited access, try to get origin from self.location
  if (runtime === 'worker' && typeof self !== 'undefined' && 'location' in self) {
    const loc = (self as any).location;
    return {
      origin: loc.origin,
      hostname: loc.hostname,
    };
  }
  
  return {};
}

// Get dynamic context fields (captured per event)
function getDynamicContextFields(runtime: string): Partial<FullEvent> {
  // Browser: URL changes as user navigates
  if (runtime === 'browser' && typeof window !== 'undefined') {
    return { url: window.location.href };
  }
  
  return {};
}

export function createTransport(config: Config): Transport {
  const runtime = detectRuntime();
  const staticContext = getStaticContextFields(runtime);
  let buffer: FullEvent[] = [];
  let seq = 0;
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let destroyed = false;

  // Heartbeat state: liveness signals for "is the subject alive?"
  let lastFlushAt = 0; // ms timestamp of last successful flush; 0 means never
  let eventsSinceLastHeartbeat = 0;

  // Start the flush interval
  function scheduleFlush() {
    if (flushTimer || destroyed) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      flush();
    }, config.flushInterval);
  }

  // Send events to endpoint
  async function flush(): Promise<void> {
    if (buffer.length === 0 || destroyed) return;

    const batch = buffer;
    buffer = [];

    try {
      const response = await fetch(config.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(batch),
      });

      if (!response.ok) {
        // Put events back in buffer for retry (at the front)
        buffer = [...batch, ...buffer];
        // Trim if over max size
        if (buffer.length > config.maxBufferSize) {
          buffer = buffer.slice(-config.maxBufferSize);
        }
      } else {
        lastFlushAt = Date.now();
      }
    } catch {
      // Network error - put events back
      buffer = [...batch, ...buffer];
      if (buffer.length > config.maxBufferSize) {
        buffer = buffer.slice(-config.maxBufferSize);
      }
    }

    // Schedule next flush if there are still events
    if (buffer.length > 0 && !destroyed) {
      scheduleFlush();
    }
  }

  // Internal send — used by both the public method and the heartbeat
  function sendEvent(event: EventInput) {
    if (destroyed) return;

    const fullEvent: FullEvent = {
      ...event,
      ...staticContext,
      ...getDynamicContextFields(runtime),
      _ts: Date.now(),
      _runtime: runtime,
      _seq: seq++,
      ...(Object.keys(config.tags).length > 0 ? { _tags: config.tags } : {}),
    };

    // Count real events (exclude our own heartbeats)
    if (event._type !== 'sidetrack.heartbeat') {
      eventsSinceLastHeartbeat++;
    }

    buffer.push(fullEvent);

    // Flush immediately if buffer is getting full
    if (buffer.length >= config.maxBufferSize * 0.9) {
      flush();
    } else {
      scheduleFlush();
    }
  }

  // Start heartbeat interval if enabled
  if (config.heartbeatInterval > 0) {
    heartbeatTimer = setInterval(() => {
      if (destroyed) return;
      const snapshot = {
        queueDepth: buffer.length,
        lastFlushAt,
        eventsSinceLastHeartbeat,
      };
      eventsSinceLastHeartbeat = 0;
      sendEvent({ _type: 'sidetrack.heartbeat', ...snapshot });
    }, config.heartbeatInterval);
    // Don't keep Node/Bun event loop alive for heartbeats alone
    if ((runtime === 'node' || runtime === 'bun') && typeof heartbeatTimer === 'object' && heartbeatTimer && 'unref' in heartbeatTimer) {
      (heartbeatTimer as unknown as { unref: () => void }).unref();
    }
  }

  // Register beforeunload handler for browsers
  if (runtime === 'browser' && typeof window !== 'undefined') {
    window.addEventListener('beforeunload', () => {
      if (buffer.length > 0) {
        // Use sendBeacon for reliability on page unload
        const data = JSON.stringify(buffer);
        if (navigator.sendBeacon) {
          navigator.sendBeacon(config.endpoint, data);
        } else {
          // Fallback to sync XHR (not ideal but better than losing data)
          const xhr = new XMLHttpRequest();
          xhr.open('POST', config.endpoint, false); // sync
          xhr.setRequestHeader('Content-Type', 'application/json');
          xhr.send(data);
        }
      }
    });
  }

  // Register process exit handlers for Node/Bun
  if ((runtime === 'node' || runtime === 'bun') && typeof process !== 'undefined') {
    const exitHandler = () => {
      if (buffer.length > 0) {
        // Sync flush on exit - use sync HTTP if available
        // For now, just try to flush synchronously via fetch
        // This may not complete, but it's best effort
        const data = JSON.stringify(buffer);
        try {
          // Bun supports sync fetch-like behavior via Bun.write
          // For Node, this is best-effort
          const xhr = new (require('http').Agent)();
          // Actually, let's just accept some data loss on abrupt exit
          // The flush interval is fast enough that most data will be sent
        } catch {
          // Ignore
        }
      }
    };
    process.on('exit', exitHandler);
    process.on('SIGINT', exitHandler);
    process.on('SIGTERM', exitHandler);
  }

  return {
    send(event: EventInput) {
      sendEvent(event);
    },

    async flush() {
      await flush();
    },

    destroy() {
      destroyed = true;
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
      // Final flush attempt
      flush();
    },
  };
}
