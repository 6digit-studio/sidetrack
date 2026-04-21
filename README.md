# Sidetrack

Development observability for AI-assisted coding. Your AI assistant can finally see what's happening in your app.

## The Problem

AI coding assistants are blind to runtime. They can read your code, but they can't see:
- What's logging to the console
- What network requests are failing
- What errors are being thrown
- What the user is clicking on

Debugging becomes a game of copy-paste telephone between you and your AI.

## The Solution

Sidetrack captures everything from your running app and makes it queryable. Your AI assistant can directly see what's happening - no more "can you paste the error message?"

```bash
# AI assistant runs this and instantly sees your app's state
curl http://localhost:6274/recent?_type=console.error
```

## Quick Start

**1. Install sidetrack globally:**

```bash
bun add -g @6digit/sidetrack
```

**2. Initialize your project:**

```bash
cd your-project
sidetrack init    # Creates .sidetrack/config.json
```

**3. Add to your app:**

```bash
npm install @6digit/sidetrack-client
# or: bun add @6digit/sidetrack-client
```

```typescript
import { init } from '@6digit/sidetrack-client'

init()  // Discovers config, auto-starts server, captures everything
```

**4. Query from anywhere in the project:**

```bash
sidetrack recent                  # Recent events
sidetrack search "error"          # Search for errors
sidetrack stats                   # Check if it's running
```

The CLI automatically finds your `.sidetrack/config.json` and talks to the right server.

## Project Configuration

Each project can have its own sidetrack server, keeping events isolated:

```bash
cd ~/src/my-app
sidetrack init              # Uses default port 6274
```

**For related projects** (frontend + API + worker) that should share a server:

```bash
cd ~/src/my-app-api
sidetrack init --port=6280

cd ~/src/my-app-frontend  
sidetrack init --port=6280  # Same port = shared server

cd ~/src/my-app-worker
sidetrack init --port=6280
```

All three projects now share the same observability backplane. Query from any of them and see the full picture.

## What Gets Captured

Everything. By default. No configuration needed.

| Category | What's Captured |
|----------|-----------------|
| **Console** | All console methods (log, warn, error, debug, info, trace, table, etc.) with stack traces |
| **Errors** | Uncaught exceptions, unhandled promise rejections |
| **Network** | Every fetch/XHR/http request and response - URL, headers, body, timing |
| **Async** | Promise lifecycle, setTimeout/setInterval (Node/Bun) |
| **DOM** | Clicks, form submissions, navigation, visibility changes (browser) |

## Multi-Runtime Support

Sidetrack auto-detects your environment and captures what's available:

| Runtime | Console | Errors | Network | Async Hooks | DOM |
|---------|:-------:|:------:|:-------:|:-----------:|:---:|
| Browser | ✓ | ✓ | ✓ | - | ✓ |
| Node.js | ✓ | ✓ | ✓ | ✓ | - |
| Bun | ✓ | ✓ | ✓ | ✓ | - |
| Deno | ✓ | ✓ | ✓ | - | - |
| Workers | ✓ | ✓ | ✓ | - | - |

## API Reference

The server is self-documenting:

```bash
curl http://localhost:6274/help
```

### Endpoints

| Endpoint | Description |
|----------|-------------|
| `POST /events` | Ingest events (any JSON) |
| `GET /recent` | Query recent events (supports compound filters, see below) |
| `GET /search?q=term` | Full-text search |
| `GET /stream` | Server-Sent Events stream of new events (`?pattern=regex` or `?cwd=/path`) |
| `GET /stats` | Event count and time span |
| `GET /help` | API documentation |
| `POST /commands` | Submit a command for a registered client to run (see Commands Backplane) |
| `GET /commands/pending` | Pending commands (clients poll this) |
| `GET /commands/:id` | Command status and result |

### Filtering

`/recent` supports compound AND filters with three operators — chain as many as you like with `&`:

```bash
# Exact match (default)
curl "http://localhost:6274/recent?_type=console.error"
curl "http://localhost:6274/recent?_runtime=bun"
curl "http://localhost:6274/recent?status=500"

# Negation — field differs from value, or is absent
curl "http://localhost:6274/recent?_type!=sidetrack.heartbeat"

# Substring — field contains value
curl "http://localhost:6274/recent?url~=/api/"

# Combine — all filters are AND'd
curl "http://localhost:6274/recent?_type=fetch.response&status=404&limit=10"
curl "http://localhost:6274/recent?url~=/api/&_type!=sidetrack.heartbeat"
```

## Checkpoints

Emit custom timing checkpoints for performance analysis and correlation:

```typescript
import { init } from '@6digit/sidetrack-client'

const sidetrack = init()
const sessionId = crypto.randomUUID()

sidetrack.checkpoint(sessionId, 'app_start')
sidetrack.checkpoint(sessionId, 'queries_subscribed', { count: 14 })
// ... time passes ...
sidetrack.checkpoint(sessionId, 'all_queries_ready')
sidetrack.checkpoint(sessionId, 'render_complete')
```

Query checkpoints by correlation ID:
```bash
curl "http://localhost:6274/recent?_type=checkpoint&id=abc-123"
```

The timestamps let you compute duration between any two checkpoints. Use the correlation ID to track a request, session, or app instance across its lifecycle.

## Heartbeats

Every client emits a `sidetrack.heartbeat` event every 10 seconds. This is a liveness signal for the subject itself, independent of whether it's doing anything interesting — so you can tell **idle** from **hung** from **queue-backed-up** at a glance.

Each heartbeat carries:

```json
{
  "_type": "sidetrack.heartbeat",
  "queueDepth": 0,
  "lastFlushAt": 1730000000000,
  "eventsSinceLastHeartbeat": 42,
  "cwd": "/Users/you/src/your-app"
}
```

- `queueDepth` — events buffered but not yet flushed
- `lastFlushAt` — ms timestamp of the last successful flush (`0` if never)
- `eventsSinceLastHeartbeat` — non-heartbeat events captured since the previous tick (heartbeats don't count themselves)

Interpret the three cases:

| What you see | Subject state |
|---|---|
| Heartbeats arriving, `queueDepth=0`, `eventsSinceLastHeartbeat=0` | **Idle** — alive, nothing to report |
| Heartbeats stopped arriving | **Hung** — crashed, frozen, or process died |
| Heartbeats arriving, `queueDepth` climbing, `lastFlushAt` not advancing | **Backed up** — alive but can't flush (server unreachable, network stalled) |

Tune or disable via the `heartbeatInterval` client option (ms, default `10000`, set to `0` to disable):

```typescript
init({ heartbeatInterval: 5000 })
```

Filter heartbeats out of routine queries with the negation operator:

```bash
curl "http://localhost:6274/recent?_type!=sidetrack.heartbeat"
```

## Commands Backplane

Clients can register handlers that other processes — CLIs, scripts, AI agents — invoke over HTTP. Useful for a loosely-coupled bus where one process exposes capabilities and another consumes them.

Register on the client:

```typescript
const sidetrack = init()
sidetrack.register('hello', (name: string) => `Hi, ${name}`)
```

Invoke from anywhere:

```bash
# Submit a command
curl -X POST http://localhost:6274/commands \
  -H "Content-Type: application/json" \
  -d '{"name":"hello","args":["world"]}'
# → {"ok":true,"id":"cmd_..."}

# Poll for the result
curl http://localhost:6274/commands/cmd_...
# → {"id":"cmd_...","status":"completed","result":"Hi, world", ...}
```

Under the hood: the client polls `/commands/pending`, runs the handler, and POSTs the result. Pending/completed/failed state is queryable for the retention window.

## Client Configuration

Sidetrack captures aggressively by default. You can dial it back if needed:

```typescript
init({
  endpoint: 'http://localhost:6274/events',  // Where to send events
  flushInterval: 500,                         // ms between flushes
  heartbeatInterval: 10000,                   // ms between heartbeats (0 disables)

  capture: {
    console: true,   // Console methods
    errors: true,    // Uncaught errors
    network: true,   // fetch/XHR/http
    async: true,     // Async hooks (Node/Bun)
    dom: true,       // DOM events (browser)
  },

  tags: {            // Added to every event
    app: 'my-app',
    env: 'development',
  },
})
```

## Server Configuration

The server reads config from, in order of precedence:

1. Environment variables
2. `.sidetrack/config.json` discovered by walking up from the cwd
3. Built-in defaults

| Env var | Default | Description |
|---|---|---|
| `PORT` | `6274` | Server port (also settable via `.sidetrack/config.json`) |
| `SIDETRACK_MAX_AGE_MS` | `3600000` (1 hour) | Retention window in milliseconds. Events older than this are pruned every 30 seconds. |

## For AI Assistants

If you're an AI assistant and the developer has sidetrack running:

```bash
# Learn the API
curl http://localhost:6274/help

# See recent activity (exclude heartbeat noise)
curl "http://localhost:6274/recent?_type!=sidetrack.heartbeat&limit=20"

# Find errors
curl "http://localhost:6274/recent?_type=console.error"
curl "http://localhost:6274/recent?_type=error.uncaught"

# See network failures — or anything touching a URL path
curl "http://localhost:6274/recent?_type=fetch.error"
curl "http://localhost:6274/recent?url~=/api/"
curl "http://localhost:6274/search?q=500"

# Check if a specific subject is alive
curl "http://localhost:6274/recent?_type=sidetrack.heartbeat&cwd=/path/to/app&limit=3"

# Check if the server itself is running
curl http://localhost:6274/stats
```

You now have direct visibility into runtime state. No more asking the human to copy-paste from DevTools.

## Design Philosophy

**Capture aggressively, query smartly.** 

The developer's machine is powerful enough to handle a firehose of events. We capture everything and let the query layer (and AI assistants) filter down to what matters. This is not a production logging system - it's a development tool that maximizes observability while minimizing setup.

- **Zero config** - Works immediately with sensible defaults
- **1-hour retention** - Recent events only (configurable via `SIDETRACK_MAX_AGE_MS`), keeps it fast
- **No schema** - Any JSON goes in, query by any field
- **Development only** - Not for production, not for metrics - for traceability and visibility into running code

## Architecture

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│   Browser   │     │   Node.js   │     │     Bun     │
│             │     │             │     │             │
│ @6digit/    │     │ @6digit/    │     │ @6digit/    │
│ sidetrack   │     │ sidetrack   │     │ sidetrack   │
└──────┬──────┘     └──────┬──────┘     └──────┬──────┘
       │                   │                   │
       └───────────────────┼───────────────────┘
                           │
                           ▼
                 POST http://localhost:6274/events
                           │
                           ▼
               ┌───────────────────────┐
               │   Sidetrack Server    │
               │                       │
               │  SQLite (in-memory)   │
               │  1-hour retention     │
               └───────────┬───────────┘
                           │
                           ▼
               GET /recent, /search, /stats
                           │
                           ▼
               ┌───────────────────────┐
               │    AI Assistant or    │
               │    Developer Query    │
               └───────────────────────┘
```

## Installation

### Requirements

**The server and CLI require [Bun](https://bun.sh/).** The server uses `bun:sqlite` and `Bun.serve()` for performance. Node.js is not supported for the server.

The client library (`@6digit/sidetrack-client`) works with any runtime (browser, Node.js, Bun, Deno).

### Global Install (Recommended)

```bash
# Install globally with Bun
bun add -g @6digit/sidetrack

# Start the server
sidetrack server

# Install the Claude skill (enables /sidetrack in Claude Code)
sidetrack install skill
```

### From Source

```bash
git clone https://github.com/6digit-studio/sidetrack.git
cd sidetrack
bun run start
```

### Client Library (for your app)

The client works with any package manager and runtime:

```bash
npm install @6digit/sidetrack-client
# or: bun add @6digit/sidetrack-client
```

Then in your app:
```typescript
import { init } from '@6digit/sidetrack-client'
init()
```

## CLI Commands

```bash
# Project setup
sidetrack init [--port=N]     # Initialize project config
sidetrack server              # Start the server manually
sidetrack install skill       # Install Claude skill to ~/.claude/skills/

# Querying
sidetrack recent [limit]      # Show recent events
sidetrack search <term>       # Search events
sidetrack stats               # Show statistics
sidetrack tail [pattern]      # Stream events in real-time
sidetrack await <pattern>     # Block until pattern matches

# Feedback
sidetrack feedback            # List open feedback
sidetrack resolve <id>        # Mark feedback resolved
sidetrack wontfix <id>        # Mark feedback as wontfix

sidetrack help                # Show active config and all commands
```

The CLI automatically discovers `.sidetrack/config.json` by walking up from your current directory.

## Claude Skill

After running `sidetrack install skill`, any Claude Code session can query sidetrack directly. The skill teaches Claude:
- How to check recent events
- How to search for errors
- How to read and manage feedback
- When to proactively check sidetrack

## Browser Script Tag (Alternative)

If you can't use the npm package:

```html
<script src="http://localhost:6274/inject.js"></script>
```

This is a simpler inline script that captures console and errors only.

## Contributing

This project exists because AI coding assistants need better observability into running applications. If you have ideas for:

- Additional capture sources (databases, state management, etc.)
- Better query capabilities
- Integrations with specific frameworks
- Performance improvements

Please open an issue or PR at [github.com/6digit-studio/sidetrack](https://github.com/6digit-studio/sidetrack).

## License

MIT
