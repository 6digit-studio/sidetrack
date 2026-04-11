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

**1. Start the sidetrack server:**

```bash
git clone https://github.com/6digit-studio/sidetrack.git
cd sidetrack
bun run index.ts
```

**2. Add to your app:**

```bash
# In your project
bun link @6digit/sidetrack
```

```typescript
import { init } from '@6digit/sidetrack'

init()  // That's it. Everything is now captured.
```

**3. Query from anywhere:**

```bash
curl http://localhost:6274/help           # See all available endpoints
curl http://localhost:6274/recent         # Recent events
curl http://localhost:6274/search?q=error # Search for errors
```

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
- **5-minute retention** - Recent events only, keeps it fast
- **No schema** - Any JSON goes in, query by any field
- **Development only** - Not for production, not for metrics, just for debugging

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
               │  5-minute retention   │
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

### Server

```bash
# Clone and run
git clone https://github.com/6digit-studio/sidetrack.git
cd sidetrack
bun run index.ts
```

Or with hot reload during development:
```bash
bun --hot index.ts
```

### Client Library

```bash
# npm
npm install @6digit/sidetrack

# bun
bun add @6digit/sidetrack

# Or link for development
bun link @6digit/sidetrack
```

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
