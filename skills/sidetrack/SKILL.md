---
name: sidetrack
description: Query Sidetrack development observability sink to debug running apps. Use when checking console output, network requests, errors, or user feedback from the in-app widget.
---

# Sidetrack - Development Observability

You have access to Sidetrack, a development observability sink that captures events from running applications. Use it to see what's happening in the user's app without asking them to copy-paste console output.

## Project Configuration

Sidetrack uses a `.sidetrack/config.json` file to configure the server port for each project. The CLI and client library automatically walk up the directory tree to find this config.

**Check if the current project has sidetrack configured:**
```bash
sidetrack help   # Shows active config if found
```

**If not configured, initialize it:**
```bash
sidetrack init   # Creates .sidetrack/config.json with default port 6274
```

**For related projects that should share a server** (e.g., frontend + API + worker):
```bash
# In each project directory, use the same port:
sidetrack init --port=6280
```

Once configured, the CLI commands automatically use the correct server for the current project.

## When to Use

- When debugging issues in running code
- When you need to see console output, network requests, or errors
- When the user reports something isn't working
- When you want to verify your changes are working
- To check for feedback the user has submitted via the in-app widget

## CLI Commands

The `sidetrack` CLI is available globally. Prefer it over raw `curl` when possible.

```bash
# Check if sidetrack is running
sidetrack stats

# Recent events
sidetrack recent
sidetrack recent 50

# Search for something specific
sidetrack search "error"
sidetrack search "notableActions"

# List open feedback from the in-app widget
sidetrack feedback

# Mark feedback as resolved or wontfix
sidetrack resolve 3
sidetrack wontfix 5
```

## Streaming (SSE)

Sidetrack supports real-time event streaming via Server-Sent Events.

**Tail** — stream events continuously (like `tail -f`):
```bash
sidetrack tail                         # all events
sidetrack tail "error|BLOCKED"         # filter by regex pattern
sidetrack tail --cwd=/path/to/project  # filter by working directory
```

**Await** — block until a matching event arrives (useful for scripts and automation):
```bash
sidetrack await "DONE"                 # block until an event matches "DONE"
sidetrack await "HANDOFF" --timeout=30 # give up after 30 seconds
```

## HTTP API

For direct HTTP access (works without the CLI):

```bash
# Stats
curl -s http://localhost:6274/stats

# Recent events
curl -s http://localhost:6274/recent?limit=20

# Only errors
curl -s "http://localhost:6274/recent?_type=console.error"

# Search
curl -s "http://localhost:6274/search?q=searchterm"

# SSE stream (with optional pattern/cwd filters)
curl -s "http://localhost:6274/stream?pattern=error&cwd=/path/to/project"
```

## Feedback System

The user can submit feedback via a floating widget in their browser. Check for open feedback:
```bash
curl -s "http://localhost:6274/feedback?status=open"
```

Each feedback item includes:
- The user's message
- The URL they were on
- Recent events (console logs, clicks, etc.)
- A DOM snapshot

Mark feedback as resolved when addressed:
```bash
curl -s -X PATCH http://localhost:6274/feedback/ID -H "Content-Type: application/json" -d '{"status": "resolved"}'
```

## Event Types

Events have a `_type` field. Common types:
- `console.log`, `console.warn`, `console.error`, `console.debug`
- `error.uncaught`, `error.unhandledrejection`
- `fetch.request`, `fetch.response`, `fetch.error`
- `dom.click`, `dom.navigate`

## Filtering

When a project has `.sidetrack/config.json`, the CLI automatically talks to the right server. You can further filter by any event field:

```bash
# By event type
sidetrack recent --filter="_type=console.error"

# Or via HTTP API
curl -s "http://localhost:6274/recent?_type=fetch.error"
curl -s "http://localhost:6274/recent?_runtime=browser"
```

**Event context fields** (automatically added to every event):

| Runtime | Context Fields |
|---------|---------------|
| Node/Bun/Deno | `cwd` — the working directory of the process |
| Browser | `origin`, `hostname`, `url` — where the page is running |

## Full API

Get complete API documentation:
```bash
curl -s http://localhost:6274/help
```

## Tips

1. **Run `sidetrack help` first** to see if the project has a config and which port it uses
2. **Check sidetrack first** when the user reports an issue - the answer is often already captured
3. **Use search** for specific error messages or function names
4. **Filter by type** to reduce noise (e.g., just `console.error` or `fetch.error`)
5. **Check feedback** regularly - the user may have left notes via the widget
6. **Network issues** show up as `fetch.error` or `fetch.response` with error status codes
