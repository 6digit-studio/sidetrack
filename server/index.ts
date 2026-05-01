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
import { startCdpListener } from "./cdp";

const DEFAULT_PORT = 6274;

// Walk up directory tree to find .sidetrack/config.json
function findConfig(): { port?: number; cdp_ports?: number[]; cdp_disabled?: boolean } | null {
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

// Tenant id helpers.
// A tenant id is a freeform-but-normalized partition key. NULL ("default bucket")
// covers all legacy / unscoped traffic.
//   - lowercase, [a-z0-9_-]+ only
//   - "_all" is reserved (would conflict with the union-all read semantics)
//   - empty / missing input normalizes to null (default bucket)
type TenantParse =
  | { ok: true; tenant: string | null }
  | { ok: false; error: string };

function normalizeTenant(raw: string | null | undefined): TenantParse {
  if (raw === null || raw === undefined || raw === '') {
    return { ok: true, tenant: null };
  }
  const lower = raw.toLowerCase();
  if (!/^[a-z0-9_-]+$/.test(lower)) {
    return { ok: false, error: `tenant id must match [a-z0-9_-]+ (case-insensitive), got "${raw}"` };
  }
  if (lower === '_all') {
    return { ok: false, error: `"_all" is reserved` };
  }
  return { ok: true, tenant: lower };
}

// Pull a `/t/:tenant` prefix off the path, returning the rest. If absent, tenant is null
// and the caller falls into the legacy unscoped routes (writes → NULL bucket, reads → union all).
function parseTenantPath(pathname: string): { raw: string | null; rest: string } {
  const m = pathname.match(/^\/t\/([^/]+)(\/.*)?$/);
  if (m) return { raw: m[1], rest: m[2] || '/' };
  return { raw: null, rest: pathname };
}

// SSE stream subscribers
interface StreamSubscriber {
  controller: ReadableStreamDefaultController;
  pattern?: RegExp;
  cwd?: string;
  tenant?: string | null; // undefined = no tenant filter (subscribe to all); null/string = exact match
}
const streamSubscribers = new Set<StreamSubscriber>();

// Broadcast event to all matching SSE subscribers
function broadcastToSubscribers(event: Record<string, unknown>, tenant: string | null) {
  const eventJson = JSON.stringify(event);
  const eventCwd = event.cwd as string | undefined;

  for (const sub of streamSubscribers) {
    // Filter by tenant if specified (subscriber asked for a specific bucket)
    if (sub.tenant !== undefined && sub.tenant !== tenant) continue;

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
    tenant TEXT,
    received_at INTEGER NOT NULL,
    data TEXT NOT NULL
  )
`);
db.run(`CREATE INDEX idx_events_received_at ON events(received_at)`);
db.run(`CREATE INDEX idx_events_tenant_received ON events(tenant, received_at)`);

// Feedback table - persistent, no pruning
db.run(`
  CREATE TABLE feedback (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant TEXT,
    created_at INTEGER NOT NULL,
    message TEXT NOT NULL,
    url TEXT,
    context TEXT,
    status TEXT DEFAULT 'open'
  )
`);
db.run(`CREATE INDEX idx_feedback_created ON feedback(created_at)`);
db.run(`CREATE INDEX idx_feedback_status ON feedback(status)`);
db.run(`CREATE INDEX idx_feedback_tenant ON feedback(tenant)`);

// Commands table - for remote command execution
db.run(`
  CREATE TABLE commands (
    id TEXT PRIMARY KEY,
    tenant TEXT,
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
db.run(`CREATE INDEX idx_commands_tenant_status ON commands(tenant, status)`);

// Prune old events periodically
setInterval(() => {
  const cutoff = Date.now() - MAX_AGE_MS;
  const result = db.run(`DELETE FROM events WHERE received_at < ?`, [cutoff]);
  if (result.changes > 0) {
    console.log(`[sidetrack] Pruned ${result.changes} old events`);
  }
}, PRUNE_INTERVAL_MS);

// Insert event(s). Tenant is the partition key — null = legacy / default bucket.
function ingestEvents(events: unknown[], tenant: string | null = null) {
  const now = Date.now();
  const insert = db.prepare(`INSERT INTO events (tenant, received_at, data) VALUES (?, ?, ?)`);

  for (const event of events) {
    const data = typeof event === 'object' ? event : { value: event };
    const dataWithMeta = { ...data, _received_at: now, _tenant: tenant } as Record<string, unknown>;
    insert.run(tenant, now, JSON.stringify(data));

    // Broadcast to SSE subscribers
    broadcastToSubscribers(dataWithMeta, tenant);
  }

  return events.length;
}

// Query recent events.
// Supports compound AND filters with three operators selected by a suffix on the key:
//   ?key=value    exact match (default)
//   ?key!=value   negation (field does not equal value, or field is absent)
//   ?key~=value   substring match (field contains value)
// Example: /recent?_type!=sidetrack.heartbeat&url~=/api/
//
// When tenant is null we union across all buckets (legacy + every named tenant).
// When tenant is a string we scope strictly to that bucket.
function getRecent(limit = 100, filters: Record<string, string> = {}, tenant: string | null = null) {
  let sql = `SELECT id, tenant, received_at, data FROM events`;
  const params: unknown[] = [];
  if (tenant !== null) {
    sql += ` WHERE tenant = ?`;
    params.push(tenant);
  }
  sql += ` ORDER BY received_at DESC, id DESC LIMIT ?`;
  params.push(limit);

  const rows = db.query(sql).all(...params) as Array<{ id: number; tenant: string | null; received_at: number; data: string }>;

  let results = rows.map(row => ({
    _id: row.id,
    _tenant: row.tenant,
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

// Search events. Tenant null = union across all buckets.
function searchEvents(query: string, limit = 50, tenant: string | null = null) {
  let sql = `SELECT id, tenant, received_at, data FROM events WHERE data LIKE ?`;
  const params: unknown[] = [`%${query}%`];
  if (tenant !== null) {
    sql += ` AND tenant = ?`;
    params.push(tenant);
  }
  sql += ` ORDER BY received_at DESC, id DESC LIMIT ?`;
  params.push(limit);

  const rows = db.query(sql).all(...params) as Array<{ id: number; tenant: string | null; received_at: number; data: string }>;

  return rows.map(row => ({
    _id: row.id,
    _tenant: row.tenant,
    _received_at: row.received_at,
    ...JSON.parse(row.data)
  })).reverse();
}

// Distinct tenants currently represented across all tables.
// Helpful for spot-checking typos (Sidetrack vs sidetrack would still fork
// in case-sensitive systems, but normalizeTenant prevents that here).
function listTenants() {
  const rows = db.query(`
    SELECT DISTINCT tenant FROM (
      SELECT tenant FROM events
      UNION SELECT tenant FROM feedback
      UNION SELECT tenant FROM commands
    )
  `).all() as Array<{ tenant: string | null }>;
  return rows.map(r => r.tenant).sort((a, b) => {
    if (a === null) return -1;
    if (b === null) return 1;
    return a.localeCompare(b);
  });
}

// Insert feedback
function insertFeedback(message: string, url?: string, context?: unknown, tenant: string | null = null) {
  const now = Date.now();
  const contextJson = context ? JSON.stringify(context) : null;
  const result = db.run(
    `INSERT INTO feedback (tenant, created_at, message, url, context) VALUES (?, ?, ?, ?, ?)`,
    [tenant, now, message, url || null, contextJson]
  );
  return result.lastInsertRowid;
}

// Get all feedback. Tenant null = union across all buckets.
function getFeedback(limit = 100, status?: string, tenant: string | null = null) {
  let query = `SELECT id, tenant, created_at, message, url, context, status FROM feedback`;
  const where: string[] = [];
  const params: (number | string | null)[] = [];

  if (status) {
    where.push(`status = ?`);
    params.push(status);
  }
  if (tenant !== null) {
    where.push(`tenant = ?`);
    params.push(tenant);
  }
  if (where.length > 0) query += ` WHERE ` + where.join(' AND ');

  query += ` ORDER BY created_at DESC LIMIT ?`;
  params.push(limit);

  const rows = db.query(query).all(...params) as Array<{
    id: number;
    tenant: string | null;
    created_at: number;
    message: string;
    url: string | null;
    context: string | null;
    status: string;
  }>;

  return rows.map(row => ({
    id: row.id,
    tenant: row.tenant,
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
function submitCommand(name: string, args: unknown[] = [], tenant: string | null = null): string {
  const id = generateCommandId();
  const now = Date.now();
  db.run(
    `INSERT INTO commands (id, tenant, created_at, name, args, status) VALUES (?, ?, ?, ?, ?, 'pending')`,
    [id, tenant, now, name, JSON.stringify(args)]
  );
  return id;
}

// Get pending commands (for clients to poll). Tenant null = union across all buckets.
function getPendingCommands(tenant: string | null = null) {
  let sql = `SELECT id, tenant, created_at, name, args FROM commands WHERE status = 'pending'`;
  const params: unknown[] = [];
  if (tenant !== null) {
    sql += ` AND tenant = ?`;
    params.push(tenant);
  }
  sql += ` ORDER BY created_at ASC`;

  const rows = db.query(sql).all(...params) as Array<{ id: string; tenant: string | null; created_at: number; name: string; args: string }>;

  return rows.map(row => ({
    id: row.id,
    tenant: row.tenant,
    created_at: row.created_at,
    name: row.name,
    args: JSON.parse(row.args || '[]')
  }));
}

// Get a specific command by ID. Command IDs are globally unique, so no tenant scoping.
function getCommand(id: string) {
  const row = db.query(`SELECT * FROM commands WHERE id = ?`).get(id) as {
    id: string;
    tenant: string | null;
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
    tenant: row.tenant,
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
      "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Content-Type": "application/json"
    };

    // Handle preflight
    if (req.method === "OPTIONS") {
      return new Response(null, { headers });
    }

    // Strip /t/:tenant prefix if present. Tenant is then either null (legacy /
    // unscoped) or a normalized string. `rest` is the remainder of the path,
    // which the routes below match against.
    const { raw: rawTenant, rest: pathname } = parseTenantPath(url.pathname);
    const tenantParse = normalizeTenant(rawTenant);
    if (!tenantParse.ok) {
      return new Response(JSON.stringify({ ok: false, error: tenantParse.error }), {
        status: 400,
        headers
      });
    }
    const tenant = tenantParse.tenant;

    // POST /events - ingest
    if (req.method === "POST" && pathname === "/events") {
      try {
        const body = await req.json();
        const events = Array.isArray(body) ? body : [body];
        const count = ingestEvents(events, tenant);
        return new Response(JSON.stringify({ ok: true, ingested: count, tenant }), { headers });
      } catch (e) {
        return new Response(JSON.stringify({ ok: false, error: String(e) }), {
          status: 400,
          headers
        });
      }
    }

    // GET /recent - query recent events
    if (req.method === "GET" && pathname === "/recent") {
      const params = Object.fromEntries(url.searchParams);
      const limit = parseInt(params.limit || "100");
      const events = getRecent(limit, params, tenant);
      return new Response(JSON.stringify(events), { headers });
    }

    // GET /search - search events
    if (req.method === "GET" && pathname === "/search") {
      const query = url.searchParams.get("q") || "";
      const limit = parseInt(url.searchParams.get("limit") || "50");
      const events = searchEvents(query, limit, tenant);
      return new Response(JSON.stringify(events), { headers });
    }

    // POST /feedback - submit feedback
    if (req.method === "POST" && pathname === "/feedback") {
      try {
        const body = await req.json();
        const { message, url: pageUrl, context } = body as { message: string; url?: string; context?: unknown };

        if (!message || typeof message !== 'string') {
          return new Response(JSON.stringify({ ok: false, error: 'message is required' }), {
            status: 400,
            headers
          });
        }

        const id = insertFeedback(message, pageUrl, context, tenant);
        return new Response(JSON.stringify({ ok: true, id, tenant }), { headers });
      } catch (e) {
        return new Response(JSON.stringify({ ok: false, error: String(e) }), {
          status: 400,
          headers
        });
      }
    }

    // GET /feedback - list all feedback
    if (req.method === "GET" && pathname === "/feedback") {
      const limit = parseInt(url.searchParams.get("limit") || "100");
      const status = url.searchParams.get("status") || undefined;
      const feedback = getFeedback(limit, status, tenant);
      return new Response(JSON.stringify(feedback), { headers });
    }

    // PATCH /feedback/:id - update feedback status
    // (Feedback IDs are globally unique — tenant scoping happens at list time, not by-id)
    if (req.method === "PATCH" && pathname.startsWith("/feedback/")) {
      const id = parseInt(pathname.split("/")[2]);
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
    if (req.method === "DELETE" && pathname.startsWith("/feedback/")) {
      const id = parseInt(pathname.split("/")[2]);
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
    if (req.method === "POST" && pathname === "/commands") {
      try {
        const body = await req.json() as { name: string; args?: unknown[] };

        if (!body.name || typeof body.name !== 'string') {
          return new Response(JSON.stringify({ ok: false, error: 'name is required' }), {
            status: 400,
            headers
          });
        }

        const id = submitCommand(body.name, body.args || [], tenant);
        return new Response(JSON.stringify({ ok: true, id, tenant }), { headers });
      } catch (e) {
        return new Response(JSON.stringify({ ok: false, error: String(e) }), {
          status: 400,
          headers
        });
      }
    }

    // GET /commands/pending - get pending commands (for clients to poll)
    if (req.method === "GET" && pathname === "/commands/pending") {
      const commands = getPendingCommands(tenant);
      return new Response(JSON.stringify(commands), { headers });
    }

    // GET /commands/:id - get command status (IDs are globally unique)
    if (req.method === "GET" && pathname.startsWith("/commands/") && pathname !== "/commands/pending") {
      const id = pathname.split("/")[2];
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
    if (req.method === "POST" && pathname.match(/^\/commands\/[^/]+\/result$/)) {
      const id = pathname.split("/")[2];

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

    // GET /stats - basic stats. Scoped to tenant when provided.
    if (req.method === "GET" && pathname === "/stats") {
      const where = tenant !== null ? `WHERE tenant = ?` : ``;
      const params = tenant !== null ? [tenant] : [];
      const count = db.query(`SELECT COUNT(*) as count FROM events ${where}`).get(...params) as { count: number };
      const oldest = db.query(`SELECT MIN(received_at) as ts FROM events ${where}`).get(...params) as { ts: number | null };
      const newest = db.query(`SELECT MAX(received_at) as ts FROM events ${where}`).get(...params) as { ts: number | null };
      return new Response(JSON.stringify({
        tenant,
        count: count.count,
        oldest_at: oldest.ts,
        newest_at: newest.ts,
        span_ms: oldest.ts && newest.ts ? newest.ts - oldest.ts : 0
      }), { headers });
    }

    // GET /tenants - list distinct tenants currently in the DB. Top-level only;
    // doesn't make sense under /t/:tenant/.
    if (req.method === "GET" && pathname === "/tenants" && tenant === null) {
      return new Response(JSON.stringify(listTenants()), { headers });
    }

    // GET /inject.js - serve the browser client.
    // Tenant resolves from path (/t/:tenant/inject.js) or `?t=foo` query param.
    if (pathname === "/inject.js") {
      const queryTenantParse = normalizeTenant(url.searchParams.get("t"));
      if (!queryTenantParse.ok) {
        return new Response(JSON.stringify({ ok: false, error: queryTenantParse.error }), {
          status: 400,
          headers
        });
      }
      const injectTenant = tenant ?? queryTenantParse.tenant;
      const ingestPath = injectTenant ? `/t/${injectTenant}/events` : `/events`;
      const injectScript = `
// 6digit-sidetrack browser inject (auto-generated)
(function() {
  const SIDETRACK_URL = 'http://localhost:${PORT}${ingestPath}';
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
    
    // GET /stream - SSE event stream.
    // Path-prefixed (/t/:tenant/stream) → subscribe to that tenant's events.
    // Top-level (/stream) → subscribe to ALL tenants (legacy behavior).
    if (req.method === "GET" && pathname === "/stream") {
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

      // tenant === null at top-level means no tenant filter (subscribe to all).
      // Under /t/:tenant we set the filter to that exact bucket.
      const tenantFilter: string | null | undefined = rawTenant === null ? undefined : tenant;

      const stream = new ReadableStream({
        start(controller) {
          const subscriber: StreamSubscriber = { controller, pattern, cwd, tenant: tenantFilter };
          streamSubscribers.add(subscriber);

          // Send initial connection message
          controller.enqueue(`data: ${JSON.stringify({ type: "connected", pattern: patternStr, cwd, tenant: tenantFilter ?? null })}\n\n`);

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
    if (pathname === "/help") {
      const helpText = `Sidetrack - Development Observability Sink
Port: ${PORT} | Retention: ${RETENTION_MINUTES} minutes

TENANTS (multi-tenant routing)
==============================
Every read/write endpoint can be prefixed with /t/:tenant to scope to a single
tenant bucket. Tenant ids are case-insensitive and match [a-z0-9_-]+ (the id
"_all" is reserved). Omitting the prefix means: writes go to the default
(NULL) bucket; reads UNION across all buckets.

  POST /events                  → write to default bucket
  POST /t/foo/events            → write to tenant "foo"
  GET  /recent                  → all events across all buckets
  GET  /t/foo/recent            → only events for tenant "foo"
  GET  /tenants                 → list all distinct tenants seen so far

ENDPOINTS
=========

POST /events  (or POST /t/:tenant/events)
  Ingest events (single object or array)
  Body: { "_type": "custom.event", "data": "..." }

GET /recent  (or GET /t/:tenant/recent)
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

GET /search?q=term  (or GET /t/:tenant/search?q=term)
  Full-text search across event data
  Params:
    ?q=searchterm     Search term (required)
    ?limit=50         Max events to return (default: 50)

GET /stats  (or GET /t/:tenant/stats)
  Event count and time span (scoped to tenant if provided)
  Returns: { tenant, count, oldest_at, newest_at, span_ms }

GET /tenants
  List all distinct tenant ids currently represented in the data.
  Useful for spotting typos. Includes null (the default bucket).

GET /stream  (or GET /t/:tenant/stream)
  Server-Sent Events stream of new events. Top-level subscribes to ALL
  tenants; /t/:tenant/stream filters to that bucket.
  Params:
    ?pattern=regex    Filter events by regex (matched against JSON)
    ?cwd=/path        Filter events by cwd field

  Events are sent as: data: {json}\\n\\n
  First event is: { "type": "connected", "pattern": "...", "cwd": "...", "tenant": "..." }

GET /inject.js  (or GET /t/:tenant/inject.js, or GET /inject.js?t=tenant)
  Browser inject script — bakes the tenant into the ingest URL it ships with.

FEEDBACK (persistent, not pruned)
=================================

POST /feedback  (or POST /t/:tenant/feedback)
  Submit feedback with context
  Body: { "message": "text", "url": "...", "context": {...} }

GET /feedback  (or GET /t/:tenant/feedback)
  List feedback
  Params:
    ?limit=100        Max items to return
    ?status=open      Filter by status (open, resolved, wontfix)

PATCH /feedback/:id
  Update feedback status (IDs are globally unique — no tenant prefix needed)
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
curl http://localhost:${PORT}/t/myproject/recent?limit=10
curl http://localhost:${PORT}/recent?_type=console.error
curl "http://localhost:${PORT}/t/myproject/recent?_type!=sidetrack.heartbeat"
curl http://localhost:${PORT}/search?q=error
curl http://localhost:${PORT}/stats
curl http://localhost:${PORT}/tenants
`;
      return new Response(helpText, {
        headers: { ...headers, "Content-Type": "text/plain" }
      });
    }

    // GET / - health check
    if (pathname === "/") {
      return new Response(JSON.stringify({
        name: "6digit-sidetrack",
        status: "running",
        port: PORT,
        tenant,
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

// CDP listener — second observability dimension. Captures renderer crashes,
// real navigation events, JS heap / DOM counter pressure. Opt-out via
// .sidetrack/config.json { "cdp_disabled": true } or env SIDETRACK_CDP_DISABLED=1.
const cdpDisabled = process.env.SIDETRACK_CDP_DISABLED === '1' || config?.cdp_disabled === true;
const cdpPorts = (() => {
  if (process.env.SIDETRACK_CDP_PORTS) {
    return process.env.SIDETRACK_CDP_PORTS.split(',').map((s) => parseInt(s.trim())).filter((n) => !isNaN(n));
  }
  if (config?.cdp_ports?.length) return config.cdp_ports;
  return [9222, 9223]; // 9222 = default Chromium, 9223 = 6digit TV browser convention
})();
if (!cdpDisabled) {
  startCdpListener(ingestEvents, {
    ports: cdpPorts,
    verbose: process.env.SIDETRACK_CDP_VERBOSE === '1'
  });
  console.log(`[sidetrack] CDP listener watching ports: ${cdpPorts.join(', ')}`);
}

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
