/**
 * Runtime detection and capability checking
 */

import type { Runtime, Capabilities } from './types';

let cachedRuntime: Runtime | null = null;
let cachedCapabilities: Capabilities | null = null;

export function detectRuntime(): Runtime {
  if (cachedRuntime) return cachedRuntime;

  // Check for Bun first (it also has process)
  if (typeof globalThis !== 'undefined' && 'Bun' in globalThis) {
    cachedRuntime = 'bun';
    return cachedRuntime;
  }

  // Check for Deno
  if (typeof globalThis !== 'undefined' && 'Deno' in globalThis) {
    cachedRuntime = 'deno';
    return cachedRuntime;
  }

  // Check for browser
  if (typeof window !== 'undefined' && typeof document !== 'undefined') {
    cachedRuntime = 'browser';
    return cachedRuntime;
  }

  // Check for Web Worker (has self but no document)
  if (typeof self !== 'undefined' && typeof (self as any).importScripts === 'function') {
    cachedRuntime = 'worker';
    return cachedRuntime;
  }

  // Check for Node.js
  if (typeof process !== 'undefined' && process.versions?.node) {
    cachedRuntime = 'node';
    return cachedRuntime;
  }

  cachedRuntime = 'unknown';
  return cachedRuntime;
}

export function getCapabilities(): Capabilities {
  if (cachedCapabilities) return cachedCapabilities;

  const runtime = detectRuntime();

  cachedCapabilities = {
    dom: runtime === 'browser',
    asyncHooks: runtime === 'node' || runtime === 'bun',
    fetch: typeof globalThis.fetch === 'function',
    xhr: typeof (globalThis as any).XMLHttpRequest !== 'undefined',
    httpModule: runtime === 'node' || runtime === 'bun',
  };

  return cachedCapabilities;
}

// Reset cache (useful for testing)
export function resetRuntimeCache(): void {
  cachedRuntime = null;
  cachedCapabilities = null;
}
