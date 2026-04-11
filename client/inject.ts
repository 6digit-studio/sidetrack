/**
 * 6digit-sidetrack browser inject
 * 
 * Drop this into your app to capture console.* to the sidetrack server.
 * 
 * Usage:
 *   import '@6digit/sidetrack/client/inject'
 * 
 * Or load as script:
 *   <script src="http://localhost:6274/inject.js"></script>
 */

const SIDETRACK_URL = 'http://localhost:6274/events';
const FLUSH_INTERVAL_MS = 1000;

let buffer: unknown[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function flush() {
  if (buffer.length === 0) return;
  
  const batch = buffer;
  buffer = [];
  
  fetch(SIDETRACK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(batch)
  }).catch(() => {
    // Silent fail - never interfere with the app
  });
}

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flush();
  }, FLUSH_INTERVAL_MS);
}

function captureContext() {
  return {
    url: window.location.href,
    title: document.title,
    ts: Date.now()
  };
}

function serializeArgs(args: unknown[]): unknown[] {
  return args.map(arg => {
    if (arg === undefined) return '[undefined]';
    if (arg === null) return null;
    if (typeof arg === 'function') return `[Function: ${arg.name || 'anonymous'}]`;
    if (typeof arg === 'symbol') return arg.toString();
    if (arg instanceof Error) {
      return { 
        __error: true, 
        name: arg.name, 
        message: arg.message, 
        stack: arg.stack 
      };
    }
    if (typeof arg === 'object') {
      try {
        // Test if it's serializable
        JSON.stringify(arg);
        return arg;
      } catch {
        return String(arg);
      }
    }
    return arg;
  });
}

function wrapConsoleMethod(method: 'log' | 'warn' | 'error' | 'debug' | 'info') {
  const original = console[method].bind(console);
  
  console[method] = (...args: unknown[]) => {
    // Always call original first
    original(...args);
    
    // Capture to sidetrack
    buffer.push({
      type: `console.${method}`,
      args: serializeArgs(args),
      ...captureContext()
    });
    
    scheduleFlush();
  };
}

// Wrap all console methods
wrapConsoleMethod('log');
wrapConsoleMethod('warn');
wrapConsoleMethod('error');
wrapConsoleMethod('debug');
wrapConsoleMethod('info');

// Capture unhandled errors
window.addEventListener('error', (event) => {
  buffer.push({
    type: 'window.error',
    message: event.message,
    filename: event.filename,
    lineno: event.lineno,
    colno: event.colno,
    error: event.error ? {
      name: event.error.name,
      message: event.error.message,
      stack: event.error.stack
    } : null,
    ...captureContext()
  });
  scheduleFlush();
});

// Capture unhandled promise rejections
window.addEventListener('unhandledrejection', (event) => {
  buffer.push({
    type: 'unhandledrejection',
    reason: String(event.reason),
    ...captureContext()
  });
  scheduleFlush();
});

// Flush on page unload
window.addEventListener('beforeunload', () => {
  flush();
});

// Announce ourselves
console.debug('[sidetrack] Observability inject loaded');
