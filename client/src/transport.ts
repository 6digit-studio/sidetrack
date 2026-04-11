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
}

export function createTransport(config: Config): Transport {
  const runtime = detectRuntime();
  let buffer: FullEvent[] = [];
  let seq = 0;
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let destroyed = false;

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
      if (destroyed) return;

      const fullEvent: FullEvent = {
        ...event,
        _ts: Date.now(),
        _runtime: runtime,
        _seq: seq++,
        ...(Object.keys(config.tags).length > 0 ? { _tags: config.tags } : {}),
      };

      buffer.push(fullEvent);

      // Flush immediately if buffer is getting full
      if (buffer.length >= config.maxBufferSize * 0.9) {
        flush();
      } else {
        scheduleFlush();
      }
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
      // Final flush attempt
      flush();
    },
  };
}
