/**
 * 6digit-sidetrack
 * 
 * A development observability sink. Captures everything, queries smartly.
 * 
 * POST /events - ingest any JSON (single or array)
 * GET /recent - get recent events (optional ?limit=N&source=X&type=Y)
 * GET /search?q=term - search events
 */

import { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "fs";
import { join, dirname } from "path";

const DEFAULT_PORT = 6274;

// Walk up directory tree to find .sidetrack/config.json
function findConfig(): { port: number } | null {
  let dir = process.cwd();
  while (dir !== '/') {
    const configPath = join(dir, '.sidetrack', 'config.json');
    if (existsSync(configPath)) {
      try {
        const config = JSON.parse(readFileSync(configPath, 'utf-8'));
        return config;
      } catch {
        // Invalid config, keep looking
      }
    }
    dir = dirname(dir);
  }
  return null;
}

// Determine port: env var > config file > default
function getPort(): number {
  // Environment variable takes precedence
  if (process.env.PORT) {
    const envPort = parseInt(process.env.PORT);
    if (!isNaN(envPort)) return envPort;
  }

  // Try to find config
  const config = findConfig();
  if (config?.port) {
    return config.port;
  }

  return DEFAULT_PORT;
}

const PORT = getPort();
const MAX_AGE_MS = process.env.SIDETRACK_MAX_AGE_MS
  ? Number(process.env.SIDETRACK_MAX_AGE_MS)
  : 60 * 60 * 1000; // 1 hour default
const RETENTION_MINUTES = Math.round(MAX_AGE_MS / 60000);
const PRUNE_INTERVAL_MS = 30 * 1000; // prune every 30 seconds

// SSE stream subscribers
interface StreamSubscriber {
  controller: ReadableStreamDefaultController;
  pattern?: RegExp;
  cwd?: string;
}
const streamSubscribers = new Set<StreamSubscriber>();

// Broadcast event to all matching SSE subscribers
function broadcastToSubscribers(event: Record<string, unknown>) {
  const eventJson = JSON.stringify(event);
  const eventCwd = event.cwd as string | undefined;
  
  for (const sub of streamSubscribers) {
    // Filter by cwd if specified
    if (sub.cwd && eventCwd !== sub.cwd) continue;
    
    // Filter by pattern if specified (match against full JSON)
    if (sub.pattern && !sub.pattern.test(eventJson)) continue;
    
    try {
      sub.controller.enqueue(`data: ${eventJson}\n\n`);
    } catch {
      // Connection closed, will be cleaned up
      streamSubscribers.delete(sub);
    }
  }
}

// Initialize SQLite
const db = new Database(":memory:"); // In-memory for now, fast and ephemeral
db.run(`
  CREATE TABLE events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    received_at INTEGER NOT NULL,
    data TEXT NOT NULL
  )
`);
db.run(`CREATE INDEX idx_received_at ON events(received_at)`);

// Feedback table - persistent, no pruning
db.run(`
  CREATE TABLE feedback (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at INTEGER NOT NULL,
    message TEXT NOT NULL,
    url TEXT,
    context TEXT,
    status TEXT DEFAULT 'open'
  )
`);
db.run(`CREATE INDEX idx_feedback_created ON feedback(created_at)`);
db.run(`CREATE INDEX idx_feedback_status ON feedback(status)`);

// Commands table - for remote command execution
db.run(`
  CREATE TABLE commands (
    id TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    name TEXT NOT NULL,
    args TEXT,
    status TEXT DEFAULT 'pending',
    result TEXT,
    error TEXT,
    completed_at INTEGER
  )
`);
db.run(`CREATE INDEX idx_commands_status ON commands(status)`);
db.run(`CREATE INDEX idx_commands_created ON commands(created_at)`);

// Prune old events periodically
setInterval(() => {
  const cutoff = Date.now() - MAX_AGE_MS;
  const result = db.run(`DELETE FROM events WHERE received_at < ?`, [cutoff]);
  if (result.changes > 0) {
    console.log(`[sidetrack] Pruned ${result.changes} old events`);
  }
}, PRUNE_INTERVAL_MS);

// Insert event(s)
function ingestEvents(events: unknown[]) {
  const now = Date.now();
  const insert = db.prepare(`INSERT INTO events (received_at, data) VALUES (?, ?)`);
  
  for (const event of events) {
    const data = typeof event === 'object' ? event : { value: event };
    const dataWithMeta = { ...data, _received_at: now } as Record<string, unknown>;
    insert.run(now, JSON.stringify(data));
    
    // Broadcast to SSE subscribers
    broadcastToSubscribers(dataWithMeta);
  }
  
  return events.length;
}

// Query recent events.
// Supports compound AND filters with three operators selected by a suffix on the key:
//   ?key=value    exact match (default)
//   ?key!=value   negation (field does not equal value, or field is absent)
//   ?key~=value   substring match (field contains value)
// Example: /recent?_type!=sidetrack.heartbeat&url~=/api/
function getRecent(limit = 100, filters: Record<string, string> = {}) {
  const rows = db.query(`
    SELECT id, received_at, data FROM events
    ORDER BY received_at DESC, id DESC
    LIMIT ?
  `).all(limit) as Array<{ id: number; received_at: number; data: string }>;

  let results = rows.map(row => ({
    _id: row.id,
    _received_at: row.received_at,
    ...JSON.parse(row.data)
  })) as Array<Record<string, unknown>>;

  for (const [rawKey, value] of Object.entries(filters)) {
    if (rawKey === 'limit') continue;

    let op: 'eq' | 'ne' | 'contains' = 'eq';
    let key = rawKey;
    if (rawKey.endsWith('!')) {
      op = 'ne';
      key = rawKey.slice(0, -1);
    } else if (rawKey.endsWith('~')) {
      op = 'contains';
      key = rawKey.slice(0, -1);
    }

    results = results.filter(e => {
      const raw = e[key];
      const fieldValue = raw === undefined || raw === null ? null : String(raw);
      if (op === 'eq') return fieldValue === value;
      if (op === 'ne') return fieldValue !== value;
      return fieldValue !== null && fieldValue.includes(value);
    });
  }

  return results.reverse(); // Chronological order
}

// Search events
function searchEvents(query: string, limit = 50) {
  const rows = db.query(`
    SELECT id, received_at, data FROM events 
    WHERE data LIKE ?
    ORDER BY received_at DESC, id DESC 
    LIMIT ?
  `).all(`%${query}%`, limit) as Array<{ id: number; received_at: number; data: string }>;
  
  return rows.map(row => ({
    _id: row.id,
    _received_at: row.received_at,
    ...JSON.parse(row.data)
  })).reverse();
}

// Insert feedback
function insertFeedback(message: string, url?: string, context?: unknown) {
  const now = Date.now();
  const contextJson = context ? JSON.stringify(context) : null;
  const result = db.run(
    `INSERT INTO feedback (created_at, message, url, context) VALUES (?, ?, ?, ?)`,
    [now, message, url || null, contextJson]
  );
  return result.lastInsertRowid;
}

// Get all feedback
function getFeedback(limit = 100, status?: string) {
  let query = `SELECT id, created_at, message, url, context, status FROM feedback`;
  const params: (number | string)[] = [];
  
  if (status) {
    query += ` WHERE status = ?`;
    params.push(status);
  }
  
  query += ` ORDER BY created_at DESC LIMIT ?`;
  params.push(limit);
  
  const rows = db.query(query).all(...params) as Array<{ 
    id: number; 
    created_at: number; 
    message: string; 
    url: string | null; 
    context: string | null;
    status: string;
  }>;
  
  return rows.map(row => ({
    id: row.id,
    created_at: row.created_at,
    message: row.message,
    url: row.url,
    context: row.context ? JSON.parse(row.context) : null,
    status: row.status
  })).reverse();
}

// Update feedback status
function updateFeedbackStatus(id: number, status: string) {
  const validStatuses = ['open', 'resolved', 'wontfix'];
  if (!validStatuses.includes(status)) {
    return { ok: false, error: `Invalid status. Must be one of: ${validStatuses.join(', ')}` };
  }
  
  const result = db.run(`UPDATE feedback SET status = ? WHERE id = ?`, [status, id]);
  return { ok: result.changes > 0 };
}

// Delete feedback by id
function deleteFeedback(id: number) {
  const result = db.run(`DELETE FROM feedback WHERE id = ?`, [id]);
  return result.changes > 0;
}

// Generate a unique command ID
function generateCommandId(): string {
  return `cmd_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

// Submit a command for execution
function submitCommand(name: string, args: unknown[] = []): string {
  const id = generateCommandId();
  const now = Date.now();
  db.run(
    `INSERT INTO commands (id, created_at, name, args, status) VALUES (?, ?, ?, ?, 'pending')`,
    [id, now, name, JSON.stringify(args)]
  );
  return id;
}

// Get pending commands (for clients to poll)
function getPendingCommands() {
  const rows = db.query(`
    SELECT id, created_at, name, args FROM commands 
    WHERE status = 'pending'
    ORDER BY created_at ASC
  `).all() as Array<{ id: string; created_at: number; name: string; args: string }>;
  
  return rows.map(row => ({
    id: row.id,
    created_at: row.created_at,
    name: row.name,
    args: JSON.parse(row.args || '[]')
  }));
}

// Get a specific command by ID
function getCommand(id: string) {
  const row = db.query(`SELECT * FROM commands WHERE id = ?`).get(id) as {
    id: string;
    created_at: number;
    name: string;
    args: string;
    status: string;
    result: string | null;
    error: string | null;
    completed_at: number | null;
  } | null;
  
  if (!row) return null;
  
  return {
    id: row.id,
    created_at: row.created_at,
    name: row.name,
    args: JSON.parse(row.args || '[]'),
    status: row.status,
    result: row.result ? JSON.parse(row.result) : null,
    error: row.error,
    completed_at: row.completed_at
  };
}

// Mark a command as completed with result
function completeCommand(id: string, result: unknown) {
  const now = Date.now();
  const resultJson = JSON.stringify(result);
  const dbResult = db.run(
    `UPDATE commands SET status = 'completed', result = ?, completed_at = ? WHERE id = ? AND status = 'pending'`,
    [resultJson, now, id]
  );
  return dbResult.changes > 0;
}

// Mark a command as failed with error
function failCommand(id: string, error: string) {
  const now = Date.now();
  const dbResult = db.run(
    `UPDATE commands SET status = 'failed', error = ?, completed_at = ? WHERE id = ? AND status = 'pending'`,
    [error, now, id]
  );
  return dbResult.changes > 0;
}

// Clean up old completed/failed commands (older than MAX_AGE_MS)
setInterval(() => {
  const cutoff = Date.now() - MAX_AGE_MS;
  const result = db.run(`DELETE FROM commands WHERE status != 'pending' AND completed_at < ?`, [cutoff]);
  if (result.changes > 0) {
    console.log(`[sidetrack] Pruned ${result.changes} old commands`);
  }
}, PRUNE_INTERVAL_MS);

// HTTP Server
const server = Bun.serve({
  port: PORT,
  idleTimeout: 255, // max value — SSE streams need long-lived connections
  async fetch(req) {
    const url = new URL(req.url);
    
    // CORS headers for browser clients
    const headers = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Content-Type": "application/json"
    };
    
    // Handle preflight
    if (req.method === "OPTIONS") {
      return new Response(null, { headers });
    }
    
    // POST /events - ingest
    if (req.method === "POST" && url.pathname === "/events") {
      try {
        const body = await req.json();
        const events = Array.isArray(body) ? body : [body];
        const count = ingestEvents(events);
        return new Response(JSON.stringify({ ok: true, ingested: count }), { headers });
      } catch (e) {
        return new Response(JSON.stringify({ ok: false, error: String(e) }), { 
          status: 400, 
          headers 
        });
      }
    }
    
    // GET /recent - query recent events
    if (req.method === "GET" && url.pathname === "/recent") {
      const params = Object.fromEntries(url.searchParams);
      const limit = parseInt(params.limit || "100");
      const events = getRecent(limit, params);
      return new Response(JSON.stringify(events), { headers });
    }
    
    // GET /search - search events
    if (req.method === "GET" && url.pathname === "/search") {
      const query = url.searchParams.get("q") || "";
      const limit = parseInt(url.searchParams.get("limit") || "50");
      const events = searchEvents(query, limit);
      return new Response(JSON.stringify(events), { headers });
    }
    
    // POST /feedback - submit feedback
    if (req.method === "POST" && url.pathname === "/feedback") {
      try {
        const body = await req.json();
        const { message, url: pageUrl, context } = body as { message: string; url?: string; context?: unknown };
        
        if (!message || typeof message !== 'string') {
          return new Response(JSON.stringify({ ok: false, error: 'message is required' }), { 
            status: 400, 
            headers 
          });
        }
        
        const id = insertFeedback(message, pageUrl, context);
        return new Response(JSON.stringify({ ok: true, id }), { headers });
      } catch (e) {
        return new Response(JSON.stringify({ ok: false, error: String(e) }), { 
          status: 400, 
          headers 
        });
      }
    }
    
    // GET /feedback - list all feedback
    if (req.method === "GET" && url.pathname === "/feedback") {
      const limit = parseInt(url.searchParams.get("limit") || "100");
      const status = url.searchParams.get("status") || undefined;
      const feedback = getFeedback(limit, status);
      return new Response(JSON.stringify(feedback), { headers });
    }
    
    // PATCH /feedback/:id - update feedback status
    if (req.method === "PATCH" && url.pathname.startsWith("/feedback/")) {
      const id = parseInt(url.pathname.split("/")[2]);
      if (isNaN(id)) {
        return new Response(JSON.stringify({ ok: false, error: 'invalid id' }), { 
          status: 400, 
          headers 
        });
      }
      
      try {
        const body = await req.json();
        const { status } = body as { status: string };
        
        if (!status) {
          return new Response(JSON.stringify({ ok: false, error: 'status is required' }), { 
            status: 400, 
            headers 
          });
        }
        
        const result = updateFeedbackStatus(id, status);
        if (!result.ok) {
          return new Response(JSON.stringify(result), { status: 400, headers });
        }
        return new Response(JSON.stringify(result), { headers });
      } catch (e) {
        return new Response(JSON.stringify({ ok: false, error: String(e) }), { 
          status: 400, 
          headers 
        });
      }
    }
    
    // DELETE /feedback/:id - delete feedback
    if (req.method === "DELETE" && url.pathname.startsWith("/feedback/")) {
      const id = parseInt(url.pathname.split("/")[2]);
      if (isNaN(id)) {
        return new Response(JSON.stringify({ ok: false, error: 'invalid id' }), { 
          status: 400, 
          headers 
        });
      }
      const deleted = deleteFeedback(id);
      return new Response(JSON.stringify({ ok: deleted }), { headers });
    }
    
    // POST /commands - submit a command for execution
    if (req.method === "POST" && url.pathname === "/commands") {
      try {
        const body = await req.json() as { name: string; args?: unknown[] };
        
        if (!body.name || typeof body.name !== 'string') {
          return new Response(JSON.stringify({ ok: false, error: 'name is required' }), { 
            status: 400, 
            headers 
          });
        }
        
        const id = submitCommand(body.name, body.args || []);
        return new Response(JSON.stringify({ ok: true, id }), { headers });
      } catch (e) {
        return new Response(JSON.stringify({ ok: false, error: String(e) }), { 
          status: 400, 
          headers 
        });
      }
    }
    
    // GET /commands/pending - get pending commands (for clients to poll)
    if (req.method === "GET" && url.pathname === "/commands/pending") {
      const commands = getPendingCommands();
      return new Response(JSON.stringify(commands), { headers });
    }
    
    // GET /commands/:id - get command status
    if (req.method === "GET" && url.pathname.startsWith("/commands/") && url.pathname !== "/commands/pending") {
      const id = url.pathname.split("/")[2];
      const cmd = getCommand(id);
      
      if (!cmd) {
        return new Response(JSON.stringify({ ok: false, error: 'command not found' }), { 
          status: 404, 
          headers 
        });
      }
      
      return new Response(JSON.stringify(cmd), { headers });
    }
    
    // POST /commands/:id/result - submit command result
    if (req.method === "POST" && url.pathname.match(/^\/commands\/[^/]+\/result$/)) {
      const id = url.pathname.split("/")[2];
      
      try {
        const body = await req.json() as { result?: unknown; error?: string };
        
        if (body.error) {
          const ok = failCommand(id, body.error);
          return new Response(JSON.stringify({ ok }), { headers });
        } else {
          const ok = completeCommand(id, body.result);
          return new Response(JSON.stringify({ ok }), { headers });
        }
      } catch (e) {
        return new Response(JSON.stringify({ ok: false, error: String(e) }), { 
          status: 400, 
          headers 
        });
      }
    }
    
    // GET /stats - basic stats
    if (req.method === "GET" && url.pathname === "/stats") {
      const count = db.query(`SELECT COUNT(*) as count FROM events`).get() as { count: number };
      const oldest = db.query(`SELECT MIN(received_at) as ts FROM events`).get() as { ts: number | null };
      const newest = db.query(`SELECT MAX(received_at) as ts FROM events`).get() as { ts: number | null };
      return new Response(JSON.stringify({
        count: count.count,
        oldest_at: oldest.ts,
        newest_at: newest.ts,
        span_ms: oldest.ts && newest.ts ? newest.ts - oldest.ts : 0
      }), { headers });
    }
    
    // GET /inject.js - serve the browser client
    if (url.pathname === "/inject.js") {
      const injectScript = `
// 6digit-sidetrack browser inject (auto-generated)
(function() {
  const SIDETRACK_URL = 'http://localhost:${PORT}/events';
  const FLUSH_INTERVAL_MS = 1000;
  
  let buffer = [];
  let flushTimer = null;
  
  function flush() {
    if (buffer.length === 0) return;
    const batch = buffer;
    buffer = [];
    fetch(SIDETRACK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(batch)
    }).catch(() => {});
  }
  
  function scheduleFlush() {
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      flush();
    }, FLUSH_INTERVAL_MS);
  }
  
  function ctx() {
    return {
      url: window.location.href,
      origin: window.location.origin,
      hostname: window.location.hostname,
      title: document.title,
      _ts: Date.now(),
      _runtime: 'browser'
    };
  }
  
  function serialize(args) {
    return args.map(arg => {
      if (arg === undefined) return '[undefined]';
      if (arg === null) return null;
      if (typeof arg === 'function') return '[Function: ' + (arg.name || 'anon') + ']';
      if (typeof arg === 'symbol') return arg.toString();
      if (arg instanceof Error) return { __error: true, name: arg.name, message: arg.message, stack: arg.stack };
      if (typeof arg === 'object') {
        try { JSON.stringify(arg); return arg; } catch { return String(arg); }
      }
      return arg;
    });
  }
  
  ['log', 'warn', 'error', 'debug', 'info'].forEach(method => {
    const orig = console[method].bind(console);
    console[method] = function(...args) {
      orig(...args);
      buffer.push({ _type: 'console.' + method, args: serialize(args), ...ctx() });
      scheduleFlush();
    };
  });
  
  window.addEventListener('error', e => {
    buffer.push({
      _type: 'error.uncaught', message: e.message, filename: e.filename,
      lineno: e.lineno, colno: e.colno,
      error: e.error ? { name: e.error.name, message: e.error.message, stack: e.error.stack } : null,
      ...ctx()
    });
    scheduleFlush();
  });
  
  window.addEventListener('unhandledrejection', e => {
    buffer.push({ _type: 'error.unhandledrejection', reason: String(e.reason), ...ctx() });
    scheduleFlush();
  });
  
  window.addEventListener('beforeunload', flush);
  
  console.debug('[sidetrack] Observability inject loaded');
})();
`;
      return new Response(injectScript, { 
        headers: { 
          ...headers, 
          "Content-Type": "application/javascript" 
        } 
      });
    }
    
    // GET /stream - SSE event stream
    if (req.method === "GET" && url.pathname === "/stream") {
      const patternStr = url.searchParams.get("pattern");
      const cwd = url.searchParams.get("cwd") || undefined;
      
      let pattern: RegExp | undefined;
      if (patternStr) {
        try {
          pattern = new RegExp(patternStr, 'i');
        } catch {
          return new Response(JSON.stringify({ ok: false, error: 'Invalid regex pattern' }), {
            status: 400,
            headers
          });
        }
      }
      
      const stream = new ReadableStream({
        start(controller) {
          const subscriber: StreamSubscriber = { controller, pattern, cwd };
          streamSubscribers.add(subscriber);

          // Send initial connection message
          controller.enqueue(`data: ${JSON.stringify({ type: "connected", pattern: patternStr, cwd })}\n\n`);

          // Keepalive ping every 15s so the connection never looks idle to Bun
          const keepalive = setInterval(() => {
            try {
              controller.enqueue(`: keepalive\n\n`);
            } catch {
              clearInterval(keepalive);
            }
          }, 15_000);

          // Cleanup on close
          req.signal.addEventListener('abort', () => {
            clearInterval(keepalive);
            streamSubscribers.delete(subscriber);
          });
        },
        cancel() {
          // Stream cancelled
        }
      });
      
      return new Response(stream, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive"
        }
      });
    }

    // GET /help - API documentation
    if (url.pathname === "/help") {
      const helpText = `Sidetrack - Development Observability Sink
Port: ${PORT} | Retention: ${RETENTION_MINUTES} minutes

ENDPOINTS
=========

POST /events
  Ingest events (single object or array)
  Body: { "_type": "custom.event", "data": "..." }

GET /recent
  Recent events in chronological order
  Params:
    ?limit=100        Max events to return (default: 100)
    ?_type=X          Filter by event type (e.g., console.error, fetch.request)
    ?_runtime=X       Filter by runtime (browser, node, bun, deno, worker)
    ?anyField=value   Filter by any field in the event data (exact match)
    ?key!=value       Negation: field is not equal to value (or missing)
    ?key~=value       Substring: field contains value
  All filters are combined as AND. Example:
    ?_type!=sidetrack.heartbeat&url~=/api/&limit=50

GET /search?q=term
  Full-text search across event data
  Params:
    ?q=searchterm     Search term (required)
    ?limit=50         Max events to return (default: 50)

GET /stats
  Event count and time span
  Returns: { count, oldest_at, newest_at, span_ms }

GET /stream
  Server-Sent Events stream of new events
  Params:
    ?pattern=regex    Filter events by regex (matched against JSON)
    ?cwd=/path        Filter events by cwd field
  
  Events are sent as: data: {json}\n\n
  First event is: { "type": "connected", "pattern": "...", "cwd": "..." }

GET /inject.js
  Legacy browser inject script (use sidetrack-client instead)

FEEDBACK (persistent, not pruned)
=================================

POST /feedback
  Submit feedback with context
  Body: { "message": "text", "url": "...", "context": {...} }

GET /feedback
  List all feedback
  Params:
    ?limit=100        Max items to return
    ?status=open      Filter by status (open, resolved, wontfix)

PATCH /feedback/:id
  Update feedback status
  Body: { "status": "resolved" }
  Valid statuses: open, resolved, wontfix

DELETE /feedback/:id
  Delete feedback by id

EVENT TYPES (from sidetrack-client)
===================================
console.log, console.warn, console.error, console.debug, console.info
error.uncaught, error.unhandledrejection
fetch.request, fetch.response, fetch.error
xhr.request, xhr.response, xhr.error
http.request, http.response, http.error
async.init, async.before, async.after, async.destroy
dom.click, dom.submit, dom.navigate, dom.visibility, dom.focus, dom.blur

EXAMPLES
========
curl http://localhost:${PORT}/recent?limit=10
curl http://localhost:${PORT}/recent?_type=console.error
curl http://localhost:${PORT}/recent?_runtime=bun
curl "http://localhost:${PORT}/recent?_type!=sidetrack.heartbeat"
curl "http://localhost:${PORT}/recent?url~=/api/&limit=20"
curl http://localhost:${PORT}/search?q=error
curl http://localhost:${PORT}/stats
`;
      return new Response(helpText, { 
        headers: { ...headers, "Content-Type": "text/plain" } 
      });
    }

    // GET / - health check
    if (url.pathname === "/") {
      return new Response(JSON.stringify({ 
        name: "6digit-sidetrack",
        status: "running",
        port: PORT,
        help: "GET /help for API documentation"
      }), { headers });
    }
    
    return new Response(JSON.stringify({ error: "Not found" }), { 
      status: 404, 
      headers 
    });
  }
});

// Show startup info
const config = findConfig();
const portSource = process.env.PORT ? 'PORT env' : config ? '.sidetrack/config.json' : 'default';

console.log(`
╔═══════════════════════════════════════════════════╗
║           6digit-sidetrack is running             ║
║                                                   ║
║   Port:    ${PORT} (from ${portSource.padEnd(22)}) ║
║                                                   ║
║   Ingest:  POST http://localhost:${PORT}/events     ║
║   Query:   GET  http://localhost:${PORT}/recent     ║
║   Search:  GET  http://localhost:${PORT}/search?q=  ║
║   Stats:   GET  http://localhost:${PORT}/stats      ║
║                                                   ║
║   Capturing last ${String(RETENTION_MINUTES).padEnd(3)} minutes of events            ║
╚═══════════════════════════════════════════════════╝
`);
