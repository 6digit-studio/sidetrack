# Sidetrack - Development Observability

You have access to Sidetrack, a development observability sink that captures events from running applications. Use it to see what's happening in the user's app without asking them to copy-paste console output.

## When to Use

- When debugging issues in running code
- When you need to see console output, network requests, or errors
- When the user reports something isn't working
- When you want to verify your changes are working
- To check for feedback the user has submitted via the in-app widget

## Quick Commands

Check if sidetrack is running:
```bash
curl -s http://localhost:6274/stats
```

See recent events:
```bash
curl -s http://localhost:6274/recent?limit=20
```

See only errors:
```bash
curl -s "http://localhost:6274/recent?_type=console.error"
```

Search for something specific:
```bash
curl -s "http://localhost:6274/search?q=searchterm"
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

Filter by any field:
```bash
# By event type
curl -s "http://localhost:6274/recent?_type=fetch.error"

# By runtime
curl -s "http://localhost:6274/recent?_runtime=browser"

# Combine filters
curl -s "http://localhost:6274/recent?_type=fetch.response&status=500"
```

## Full API

Get complete API documentation:
```bash
curl -s http://localhost:6274/help
```

## Tips

1. **Check sidetrack first** when the user reports an issue - the answer is often already captured
2. **Use search** for specific error messages or function names
3. **Filter by type** to reduce noise (e.g., just `console.error` or `fetch.error`)
4. **Check feedback** regularly - the user may have left notes via the widget
5. **Network issues** show up as `fetch.error` or `fetch.response` with error status codes
