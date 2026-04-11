/**
 * Core types for sidetrack-client
 */

export type Runtime = 'browser' | 'node' | 'bun' | 'deno' | 'worker' | 'unknown';

export interface Capabilities {
  dom: boolean;
  asyncHooks: boolean;
  fetch: boolean;
  xhr: boolean;
  httpModule: boolean;
}

export interface Config {
  endpoint: string;
  flushInterval: number;
  maxBufferSize: number;
  capture: {
    console: boolean;
    errors: boolean;
    network: boolean;
    async: boolean;
    dom: boolean;
  };
  network: {
    maxBodySize: number;
    captureHeaders: boolean;
  };
  tags: Record<string, string>;
}

export const DEFAULT_CONFIG: Config = {
  endpoint: 'http://localhost:6274/events',
  flushInterval: 500,
  maxBufferSize: 10000,
  capture: {
    console: true,
    errors: true,
    network: true,
    async: true,
    dom: true,
  },
  network: {
    maxBodySize: 1_000_000, // 1MB
    captureHeaders: true,
  },
  tags: {},
};

// Base event envelope
export interface BaseEvent {
  _type: string;
  _ts: number;
  _runtime: Runtime;
  _seq: number;
  _tags?: Record<string, string>;
}

// Console events
export interface ConsoleEvent extends BaseEvent {
  _type: `console.${string}`;
  args: unknown[];
  stack?: string;
}

// Error events
export interface ErrorEvent extends BaseEvent {
  _type: 'error.uncaught' | 'error.unhandledrejection';
  message: string;
  stack?: string;
  filename?: string;
  lineno?: number;
  colno?: number;
}

// Network events
export interface NetworkRequestEvent extends BaseEvent {
  _type: 'fetch.request' | 'xhr.request' | 'http.request';
  id: string;
  url: string;
  method: string;
  headers?: Record<string, string>;
  body?: unknown;
}

export interface NetworkResponseEvent extends BaseEvent {
  _type: 'fetch.response' | 'xhr.response' | 'http.response';
  id: string;
  url: string;
  status: number;
  statusText?: string;
  headers?: Record<string, string>;
  body?: unknown;
  durationMs: number;
}

export interface NetworkErrorEvent extends BaseEvent {
  _type: 'fetch.error' | 'xhr.error' | 'http.error';
  id: string;
  url: string;
  error: string;
  durationMs: number;
}

// Async events
export interface AsyncEvent extends BaseEvent {
  _type: 'async.init' | 'async.before' | 'async.after' | 'async.destroy' | 'async.promiseResolve';
  asyncId: number;
  triggerAsyncId: number;
  resourceType: string;
}

// DOM events
export interface DomClickEvent extends BaseEvent {
  _type: 'dom.click';
  target: string;
  x: number;
  y: number;
}

export interface DomSubmitEvent extends BaseEvent {
  _type: 'dom.submit';
  target: string;
  action?: string;
  method?: string;
}

export interface DomNavigateEvent extends BaseEvent {
  _type: 'dom.navigate';
  from: string;
  to: string;
  trigger: 'popstate' | 'hashchange' | 'pushstate' | 'replacestate';
}

export interface DomVisibilityEvent extends BaseEvent {
  _type: 'dom.visibility';
  state: 'visible' | 'hidden';
}

export interface DomFocusEvent extends BaseEvent {
  _type: 'dom.focus' | 'dom.blur';
}

export type SidetrackEvent =
  | ConsoleEvent
  | ErrorEvent
  | NetworkRequestEvent
  | NetworkResponseEvent
  | NetworkErrorEvent
  | AsyncEvent
  | DomClickEvent
  | DomSubmitEvent
  | DomNavigateEvent
  | DomVisibilityEvent
  | DomFocusEvent;

// Event input (what capture modules send - doesn't need envelope fields)
export interface EventInput {
  _type: string;
  [key: string]: unknown;
}

// Transport interface
export interface Transport {
  send(event: EventInput): void;
  flush(): Promise<void>;
  destroy(): void;
}

// Capture module interface
export interface CaptureModule {
  destroy(): void;
}
