# 6digit-sidetrack

A development observability sink for AI-assisted development. Captures everything, queries smartly.

## The Problem

When debugging reactive systems with an AI assistant, the feedback loop is broken:
- The human stares at browser DevTools
- The AI is blind to runtime state
- Debugging becomes a game of copy-paste telephone

## The Solution

Sidetrack runs alongside your development session as a parallel track, capturing all events from browsers, servers, and tools. The AI can query it directly - no more copy-pasting from console.

## Quick Start

```bash
# Start the server
bun run index.ts

# In your browser app, add to <head>:
<script src="http://localhost:6274/inject.js"></script>

# Now query from anywhere:
curl http://localhost:6274/recent
curl "http://localhost:6274/search?q=error"
```

## API

### Ingest Events

```bash
# Single event (any JSON)
POST http://localhost:6274/events
{"anything": "goes", "no": "schema"}

# Batch events
POST http://localhost:6274/events
[{"event": 1}, {"event": 2}, {"event": 3}]
```

### Query Events

```bash
# Recent events (default 100)
GET http://localhost:6274/recent
GET http://localhost:6274/recent?limit=50

# Filter by any field
GET http://localhost:6274/recent?type=console.error
GET http://localhost:6274/recent?project=my-app

# Search event data
GET http://localhost:6274/search?q=searchterm
GET http://localhost:6274/search?q=error&limit=20

# Stats
GET http://localhost:6274/stats
```

### Browser Inject

The server serves a browser client at `/inject.js` that:
- Hooks `console.log`, `console.warn`, `console.error`, `console.debug`, `console.info`
- Captures `window.error` and `unhandledrejection`
- Batches events and flushes every second
- Includes page URL and title with every event
- Never blocks or interferes with normal operation

## Design Principles

1. **Dumb ingest, smart query** - No schema, no validation, no filtering at capture time. Just swallow everything.

2. **Developer machine scale** - Not enterprise observability. Last 5 minutes, one machine, instant queries.

3. **Zero config** - One port (6274), one endpoint, works immediately.

4. **Multi-project** - One server handles all your projects. Events can have `project` or any field you want - query filters by it.

## Architecture

```
Browser ──────┐
              │
Satellite ────┼──► POST /events ──► SQLite (in-memory) ──► GET /recent
              │                                           GET /search
Server logs ──┘
```

- **Storage**: In-memory SQLite, auto-prunes events older than 5 minutes
- **Port**: 6274 (mnemonic: "6digit" → 6274)
- **CORS**: Enabled for all origins

## For AI Assistants

If you're an AI assistant working with a developer who has sidetrack running:

```bash
# See what just happened
curl http://localhost:6274/recent?limit=20

# Search for specific events
curl "http://localhost:6274/search?q=error"
curl "http://localhost:6274/search?q=notableActions"

# Check if it's running
curl http://localhost:6274/stats
```

You now have direct visibility into the browser console, reactive state updates, and any other events the developer's tools emit.

## License

MIT
