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

const PORT = 6274;
const MAX_AGE_MS = 5 * 60 * 1000; // 5 minutes
const PRUNE_INTERVAL_MS = 30 * 1000; // prune every 30 seconds

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
    insert.run(now, JSON.stringify(data));
  }
  
  return events.length;
}

// Query recent events
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
  }));
  
  // Apply filters (simple key matching)
  for (const [key, value] of Object.entries(filters)) {
    if (key === 'limit') continue;
    results = results.filter(e => String(e[key]) === value);
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

// HTTP Server
const server = Bun.serve({
  port: PORT,
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
    return { url: window.location.href, title: document.title, ts: Date.now() };
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
      buffer.push({ type: 'console.' + method, args: serialize(args), ...ctx() });
      scheduleFlush();
    };
  });
  
  window.addEventListener('error', e => {
    buffer.push({
      type: 'window.error', message: e.message, filename: e.filename,
      lineno: e.lineno, colno: e.colno,
      error: e.error ? { name: e.error.name, message: e.error.message, stack: e.error.stack } : null,
      ...ctx()
    });
    scheduleFlush();
  });
  
  window.addEventListener('unhandledrejection', e => {
    buffer.push({ type: 'unhandledrejection', reason: String(e.reason), ...ctx() });
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
    
    // GET /help - API documentation
    if (url.pathname === "/help") {
      const helpText = `Sidetrack - Development Observability Sink
Port: ${PORT} | Retention: 5 minutes

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
    ?anyField=value   Filter by any field in the event data

GET /search?q=term
  Full-text search across event data
  Params:
    ?q=searchterm     Search term (required)
    ?limit=50         Max events to return (default: 50)

GET /stats
  Event count and time span
  Returns: { count, oldest_at, newest_at, span_ms }

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

console.log(`
╔═══════════════════════════════════════════════════╗
║           6digit-sidetrack is running             ║
║                                                   ║
║   Ingest:  POST http://localhost:${PORT}/events     ║
║   Query:   GET  http://localhost:${PORT}/recent     ║
║   Search:  GET  http://localhost:${PORT}/search?q=  ║
║   Stats:   GET  http://localhost:${PORT}/stats      ║
║                                                   ║
║   Capturing last 5 minutes of events              ║
╚═══════════════════════════════════════════════════╝
`);
