# Backplane: Inter-Agent Communication for Sidetrack

## Vision

Turn Sidetrack into a loose, natural-language backplane for agent coordination. LLMs don't need rigid schemas - they need streams of context they can pattern-match over.

**Key insight:** The formalization crowd wants clean APIs. We want faucets of data that LLMs can make sense of.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      CORDIAL Surface                        │
│                    (chat widget, human)                     │
└─────────────────────────────────────────────────────────────┘
                              ▲
                              │ reads from Convex (only)
                              │
┌─────────────────────────────────────────────────────────────┐
│                         Convex                              │
│                   (acp/events table)                        │
│              persistent, cross-session queries              │
└─────────────────────────────────────────────────────────────┘
                              ▲
                              │ writes
                              │
┌─────────────────────────────┴───────────────────────────────┐
│                        Satellite                            │
│  - Fan-out: ACP events → Convex (persistent)               │
│                        → Sidetrack (local observability)    │
│  - Subscription patterns → wake-up signals                  │
│  - Config: which brains, what patterns                      │
└─────────────────────────────────────────────────────────────┘
            │                               │
            ▼                               ▼
┌───────────────────────┐     ┌───────────────────────────────┐
│      Sidetrack        │     │        ACP Sessions           │
│  (standalone, local)  │     │  (claude-code, opencode, etc) │
│  OPTIONAL leaf node   │     │                               │
│  - POST /events       │     │  wake-up injection:           │
│  - GET /recent        │     │  "While idle, this appeared:" │
│  - GET /stream (SSE)  │     │                               │
│  - sidetrack await    │     │                               │
│                       │     │                               │
│  5-min ephemeral      │     │                               │
│  No dependencies      │     │                               │
└───────────────────────┘     └───────────────────────────────┘
```

**Dependency graph is acyclic:**
- CORDIAL → Convex (reads)
- Satellite → Convex (writes)
- Satellite → Sidetrack (writes, optional)
- Satellite → ACP Sessions (manages)
- Sidetrack is a leaf node: nothing depends on it for correctness

## Design Principles

1. **Sidetrack stays standalone** - no Convex dependency, works for anyone, optional for 6digit-studio
2. **Satellite is the fan-out point** - writes to both Convex (persistent) and Sidetrack (ephemeral)
3. **CORDIAL reads from Convex only** - no runtime dependency on Sidetrack
4. **Natural language all the way** - no message schemas, just grep-friendly conventions
5. **Local vocabulary** - teams define their own patterns (BLOCKED, HANDOFF, FYI, etc.)
6. **Acyclic dependencies** - data flows one direction, no component depends on a downstream consumer

## Work Phases

### Phase 1: Sidetrack SSE Stream ✅
Location: `6digit-sidetrack`

Add real-time streaming to Sidetrack so consumers can tail events.

- [x] `GET /stream` - SSE endpoint, sends new events as they arrive
- [x] `GET /stream?pattern=X` - filter stream by regex
- [x] `GET /stream?cwd=X` - filter stream by working directory
- [x] Update `sidetrack tail` CLI command to use SSE

### Phase 2: Satellite Fan-Out ✅
Location: `6digit-satellite`

Satellite becomes the fan-out point, writing ACP events to both Convex and Sidetrack.

- [x] Buffered, fire-and-forget queue (`sidetrack-queue.ts`)
- [x] In `ACPSession.pushEvent()`:
  - [x] Write to Convex `acp/events` table (persistent, required)
  - [x] POST to Sidetrack (ephemeral, optional, fire-and-forget)
- [x] Include: sessionId, satelliteId, event type, payload
- [x] Sidetrack failures silently drop (doesn't affect Convex writes)
- [x] Works automatically when Sidetrack is running on localhost:6274

### Phase 3: Satellite Subscriptions & Wake-up
Location: `6digit-satellite`

Let sessions subscribe to patterns and get woken up.

- [ ] Subscription registry in satellite (pattern → session mapping)
- [ ] Expose to agents: `subscribe`, `unsubscribe` (new ACP tools? or via backplane post?)
- [ ] Watch Sidetrack stream for pattern matches
- [ ] Inject wake-up context into session's next prompt
- [ ] Rate limiting / debounce / batch window
- [ ] Config: per-brain default subscriptions

### Phase 4: CORDIAL Chat Widget
Location: `6digit` (orchestrator)

Human-facing stream view on the CORDIAL surface. **Reads from Convex only** - no Sidetrack dependency.

- [ ] Floating/dockable chat widget component
- [ ] Reads from Convex `acp/events` table (real-time subscription)
- [ ] Filter by brain, pattern, cwd
- [ ] Human can post messages to backplane (writes to Convex)
- [ ] Click message → jump to that session
- [ ] Visual distinction: agent messages vs human messages
- [ ] Works even if Sidetrack is not running

### Phase 5: `sidetrack await` CLI ✅
Location: `6digit-sidetrack`

Block until a pattern appears. Useful for scripts, CI, automation.

- [x] `sidetrack await <pattern>` - blocks until match
- [x] `--timeout=N` - fail after N seconds
- [x] `--cwd=X` - scope to working directory
- [x] Exit 0 on match, exit 1 on timeout
- [x] Print matching event to stdout (as JSON)

## Vocabulary Conventions (Example)

Not enforced by code - just team agreement. Put in CLAUDE.md or satellite config.

```
BLOCKED: <reason>      - I need help with something
RESOLVED: <topic>      - Something is fixed/unblocked
HANDOFF: <context>     - Explicitly passing work to another agent
FYI: <observation>     - Low-priority context, no action needed
DONE: <summary>        - Task complete
ERROR: <details>       - Something failed
```

## Why Sidetrack Still Matters

Even though CORDIAL reads from Convex and Sidetrack is optional, it serves distinct purposes:

1. **Local debugging** - `sidetrack tail` gives you a terminal view without needing the full studio
2. **Standalone usage** - Teams not using 6digit-studio can still use Sidetrack for observability
3. **No network dependency** - Works offline, no Convex account needed
4. **Different retention model** - 5-minute ephemeral vs Convex's persistent storage
5. **CLI tooling** - `sidetrack await` for scripts and automation

The pattern: Convex is the **source of truth**, Sidetrack is a **convenience tap**.

## Open Questions

1. **Wake-up injection format** - How exactly does context appear in the session?
   - Prefix to next user prompt?
   - System message update?
   - Synthetic "backplane" tool call?

2. **Subscription management** - How do agents subscribe/unsubscribe?
   - New ACP tool calls?
   - Post to backplane with special prefix? (`SUBSCRIBE: pattern`)
   - Config-only (no runtime changes)?

3. **Cross-machine** - For now, localhost only. Future: could Sidetrack sync across machines?

4. **Retention** - 5 minutes enough? Should backplane events have longer retention?

## Session Recovery Notes

When satellite restarts or sessions are lost:
- Sidetrack data persists (within retention window)
- Subscriptions need to be re-registered
- Consider: persist subscriptions to disk?
