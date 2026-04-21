# 6digit-sidetrack

Development observability sink for AI-assisted development.

## What This Is

A local HTTP server that captures structured events from browsers, satellites, and any other source. Stores the last hour in-memory (tunable via `SIDETRACK_MAX_AGE_MS`). Queryable via HTTP.

The core insight: **Dumb ingest, smart query.** No schema, no filtering at capture time. Just swallow everything, query it later.

## Commands

```bash
# Start the server
bun run index.ts

# Or with hot reload during development
bun --hot index.ts
```

## Architecture

- **Port**: 6274
- **Storage**: In-memory SQLite via `bun:sqlite`
- **Retention**: 1 hour by default (override with `SIDETRACK_MAX_AGE_MS` env var, in ms), auto-pruned every 30 seconds

## Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/events` | POST | Ingest single event or array of events |
| `/recent` | GET | Query recent events, optional `?limit=N&field=value` |
| `/search` | GET | Search event data `?q=term&limit=N` |
| `/stats` | GET | Event count and time span |
| `/inject.js` | GET | Browser client script |

## Browser Integration

The server serves a self-contained browser client at `/inject.js`. It:
- Hooks all console methods
- Captures unhandled errors
- Batches and flushes every second
- Includes URL and page title

To use in any web app:
```html
<script src="http://localhost:6274/inject.js"></script>
```

## Querying (for AI assistants)

```bash
# Recent events
curl http://localhost:6274/recent?limit=20

# Filter by field
curl "http://localhost:6274/recent?type=console.error"

# Search
curl "http://localhost:6274/search?q=notableActions"
```

## Using Bun

This project uses Bun. Key patterns:
- `bun:sqlite` for database
- `Bun.serve()` for HTTP server
- No external dependencies for core functionality
