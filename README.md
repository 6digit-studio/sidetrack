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
| `GET /recent` | Query recent events |
| `GET /search?q=term` | Full-text search |
| `GET /stats` | Event count and time span |
| `GET /help` | API documentation |

### Filtering

```bash
# By event type
curl "http://localhost:6274/recent?_type=console.error"
curl "http://localhost:6274/recent?_type=fetch.request"

# By runtime
curl "http://localhost:6274/recent?_runtime=browser"
curl "http://localhost:6274/recent?_runtime=bun"

# By any field
curl "http://localhost:6274/recent?status=500"

# Combine filters
curl "http://localhost:6274/recent?_type=fetch.response&status=404&limit=10"
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

## Configuration

Sidetrack captures aggressively by default. You can dial it back if needed:

```typescript
init({
  endpoint: 'http://localhost:6274/events',  // Where to send events
  flushInterval: 500,                         // ms between flushes
  
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

## For AI Assistants

If you're an AI assistant and the developer has sidetrack running:

```bash
# Learn the API
curl http://localhost:6274/help

# See recent activity
curl http://localhost:6274/recent?limit=20

# Find errors
curl "http://localhost:6274/recent?_type=console.error"
curl "http://localhost:6274/recent?_type=error.uncaught"

# See network failures
curl "http://localhost:6274/recent?_type=fetch.error"
curl "http://localhost:6274/search?q=500"

# Check if it's running
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
