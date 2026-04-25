# codex-mcp-server — Architecture & Bug Fixes

> Last updated: 2026-04-25  
> All 88 tests passing. Lint, build, format green.

---

## What It Does

`codex-mcp-server` is an MCP (Model Context Protocol) server that wraps the [Codex CLI](https://github.com/openai/codex). It translates JSON-RPC tool calls from an MCP client (e.g. Claude Code) into `codex exec` child process invocations and streams output back.

**Transport:** stdio (newline-delimited JSON-RPC over stdin/stdout)  
**Tools exposed:** `codex`, `review`, `ping`, `help`, `listSessions`, `websearch`

---

## Source Layout

```
src/
├── index.ts                  entry point — creates and starts CodexMcpServer
├── server.ts                 MCP server lifecycle, request routing, call queue, timeouts
├── types.ts                  Zod schemas, tool argument types, shared constants
├── errors.ts                 typed error classes (ValidationError, ToolExecutionError, etc.)
├── runtime-config.ts         reads STARTUP_LOGGING_ENABLED env var
├── tools/
│   ├── definitions.ts        MCP tool descriptors (name, description, inputSchema)
│   └── handlers.ts           one handler class per tool; spawns codex CLI processes
├── utils/
│   └── command.ts            executeCommand / executeCommandStreaming — process spawn helpers
└── session/
    └── storage.ts            InMemorySessionStorage — tracks multi-turn Codex conversations
```

---

## Architecture

### Request Lifecycle (server.ts)

1. MCP client sends `tools/call` JSON-RPC request over stdin
2. `CodexMcpServer.setupHandlers()` receives it via `@modelcontextprotocol/sdk`
3. Request is pushed onto **`callQueue`** (a `Promise<void>` chain) — this serializes all calls
4. Inside the queue slot:
   - An `AbortController` is created for this call
   - A `ToolHandlerContext` is built (holds `progressToken`, `abortSignal`, `sendProgress`)
   - The appropriate `ToolHandler.execute()` is called
   - `withTimeout()` races the operation against a deadline; on timeout it calls `controller.abort()`
5. Handler result is returned to the MCP client as a `ToolResult`
6. If the handler throws, a structured error response is returned (never crashes the server)
7. The queue slot releases only after the child process fully exits (prevents backpressure)

### Call Queue (critical for stability)

```typescript
private callQueue: Promise<void> = Promise.resolve();

// Each incoming call appends to the chain:
this.callQueue = this.callQueue.then(async () => {
  // ... run the tool ...
  await operation?.then(() => undefined, () => undefined); // wait for child exit
});
```

This ensures calls are fully serialized. The MCP stdio transport cannot handle concurrent writes to stdout, and rapid sequential calls were previously racing on the same stream.

### Timeout & Abort Chain

```
withTimeout(operation, timeoutMs, controller)
  → fires controller.abort() at deadline
    → AbortSignal propagates to executeCommand / executeCommandStreaming
      → child.kill('SIGTERM')
      → child.kill('SIGKILL') after 2000ms if still alive
```

Default timeout: `CODEX_TOOL_TIMEOUT_MS` env var, fallback 120,000ms.  
Per-call override: `timeoutMs` parameter in the tool call.

### Tool Handlers (tools/handlers.ts)

| Handler | Spawns | Notes |
|---|---|---|
| `CodexToolHandler` | `codex exec [args] <prompt>` | Supports sessions, resume, sandbox, fullAuto |
| `ReviewToolHandler` | `codex review [args]` | Code diff review via Codex |
| `WebSearchToolHandler` | `codex --search exec <prompt>` | Enables Codex's web_search tool |
| `PingToolHandler` | nothing | Returns a message; used to health-check the server |
| `HelpToolHandler` | `codex --help` | Returns CLI help text |
| `ListSessionsToolHandler` | nothing | Lists in-memory sessions |

### Session Storage (session/storage.ts)

`InMemorySessionStorage` maps caller-provided `sessionId` strings to `SessionData` objects.  
Each session tracks:
- Conversation turns (prompt + response)
- The Codex-assigned `codexConversationId` (used for `codex exec resume <id>`)
- TTL: 24 hours; max 100 sessions (LRU eviction)

On the first call with a `sessionId`, the server creates or finds the session. On subsequent calls, it passes `--resume <conversationId>` to `codex exec`, letting Codex maintain its own conversation context natively.

### Process Spawn (utils/command.ts)

Both `executeCommand` and `executeCommandStreaming` share the same spawn pattern:

- `shell: false` on Linux/macOS (no intermediate shell process)
- `detached: true` when an `AbortSignal` is provided (creates process group for clean kill)
- `child.stdin?.end()` — **immediately closes stdin** on the child process
- On abort: `child.kill('SIGTERM')`, then `process.kill(-child.pid, 'SIGTERM')` on the group, then `SIGKILL` after 2000ms
- stdout + stderr both buffered up to 10MB; truncation is logged
- Exit condition: `code === 0 OR stdout OR stderr` — because `codex` writes primary output to stderr

---

## Bug Fixes

### 1. Concurrent Call Race (callQueue)

**Commit:** `ac66ca1 fix: serialize concurrent tools/call requests to prevent stdio race`

**Bug:** The MCP server had no call queue. If two tool calls arrived in rapid succession, both would execute concurrently, writing to stdout simultaneously. This corrupted the JSON-RPC stream, causing the MCP client to lose sync and report "Not connected".

**Fix:** All calls are now appended to a `Promise` chain (`callQueue`). Each new call waits for the previous one to fully complete before starting. The queue slot is released only after the child process exits (see fix #2).

---

### 2. Queue Slot Released Before Child Exit

**Commit:** `a1cd967 fix: block queue until timed out codex child exits`

**Bug:** After the first fix, the queue slot was released as soon as `resolve()` was called — but the spawned child process was still running. The next queued call would start while the previous `codex exec` process was still writing to its own stdout/stderr, creating a second race.

**Fix:** The `finally` block in the queue handler now explicitly awaits the operation promise (ignoring errors) before the queue slot is released:

```typescript
finally {
  await operation?.then(() => undefined, () => undefined);
}
```

This ensures the previous child process has fully exited before the next call starts.

---

### 3. Server Exiting Between Tool Calls

**Commit:** `ec091db fix: keep server alive between tool calls`

**Bug:** An earlier diagnostic code path caused the server process to call `process.exit()` on idle or on certain error conditions, which terminated the MCP server. Callers would then get "Not connected" on the next tool call.

**Fix:** Removed all `process.exit()` calls from normal operation paths. The server now only exits if the MCP transport itself closes (i.e., the parent process closes stdin). Errors from tool calls are caught and returned as error-flagged `ToolResult` objects.

---

### 4. stdin Never Closed — codex exec Hangs

**Present in:** `utils/command.ts`, line `child.stdin?.end()`

**Bug:** When `codex exec` is spawned with `stdio: 'pipe'`, it detects that stdin is a pipe and enters an interactive "Reading additional input from stdin..." loop, waiting indefinitely for EOF. This caused every `codex exec` call to hang until the server process died.

**Fix:** `child.stdin?.end()` is called immediately after spawn, sending EOF to the child's stdin. `codex exec` then detects EOF and exits conversational mode, running the provided prompt non-interactively.

---

### 5. No Timeout on Tool Calls — Queue Starvation

**Commits:** `358c106` (initial), `b1765ef fix: add per-call codex timeout override`

**Bug:** If a `codex exec` call hung (e.g., network timeout, model unavailability), it would block the call queue indefinitely. All subsequent tool calls would queue up and never run. From the caller's perspective, the server appeared to accept calls but never respond.

**Fix 1 (`CODEX_TOOL_TIMEOUT_MS`):** A configurable timeout (default 120s, now set to 300s via env var) triggers `controller.abort()`, which kills the child process and rejects the queued call. The queue unblocks.

**Fix 2 (`timeoutMs` parameter):** Callers can override the timeout per-call via the `timeoutMs` field in the tool input. `getRequestTimeoutMs()` in `server.ts` reads this and passes it to `withTimeout()`. Useful for large tasks that legitimately need more time.

---

### 6. DEFAULT_CODEX_MODEL Stale (types.ts)

**Fixed:** 2026-04-25

**Bug:** `DEFAULT_CODEX_MODEL` was still set to `'gpt-5.3-codex'`, which has been migrated to `gpt-5.4`. Any call that didn't pass an explicit `model` parameter would fall back to a non-existent model alias.

**Fix:** Updated `DEFAULT_CODEX_MODEL = 'gpt-5.4'` and added `'gpt-5.4'` to `AVAILABLE_CODEX_MODELS`.

---

## Configuration

### Environment Variables

| Variable | Default | Description |
|---|---|---|
| `CODEX_TOOL_TIMEOUT_MS` | 120000 | Default timeout (ms) for all tool calls |
| `CODEX_DEFAULT_MODEL` | (unset) | Override default model; falls back to `DEFAULT_CODEX_MODEL` |
| `CODEX_MCP_CALLBACK_URI` | (unset) | Optional callback URI passed to `codex exec` |
| `STRUCTURED_CONTENT_ENABLED` | (unset) | Set to `1`/`true` to enable `structuredContent` in responses |
| `STARTUP_LOGGING_ENABLED` | (unset) | Set to `1`/`true` to log server start message |

### Codex CLI Config (~/.codex/config.toml)

```toml
model = "gpt-5.4"
model_reasoning_effort = "xhigh"
approval_policy = "never"   # non-interactive; required for MCP use

[notice.model_migrations]
"gpt-5.2-codex" = "gpt-5.3-codex"
"gpt-5.1-codex-mini" = "gpt-5.4"
"gpt-5.3-codex" = "gpt-5.4"
```

`approval_policy = "never"` is critical — without it, `codex exec` prompts for approval on file writes, which hangs the process when stdin is closed.

### MCP Registration

```bash
claude mcp remove codex -s user
claude mcp add codex -s user \
  -e CODEX_TOOL_TIMEOUT_MS=300000 \
  -- codex-mcp-server
```

Verify: `claude mcp list`

### Building & Installing

```bash
cd /media/nicolai/ThickGbs/Laudio/codex-mcp-server
npm install
npm run build
npm install -g .   # updates /home/nicolai/.local/npm/bin/codex-mcp-server
```

---

## Rules for Callers (Claude / MCP clients)

### Sequential Only — No Parallel Calls

**Never fire two `mcp__codex__codex` calls in the same turn.** The server serializes them internally, but Claude Code's session lifecycle (SIGINT/SIGTERM at session boundaries) means a second call can hit a restarting server and get "Not connected".

Always await one call fully before issuing the next.

### Recommended Call Parameters

```json
{
  "prompt": "Self-contained task description with exact file paths",
  "model": "gpt-5.4",
  "workingDirectory": "/absolute/path/to/project",
  "fullAuto": true,
  "timeoutMs": 300000
}
```

### Retry Pattern

1. If "Not connected": wait 8–10s, run `ping`, retry once
2. If timeout: wait for server reconnect, retry with `timeoutMs: 480000`
3. Never retry in a loop — max 2 attempts per task, then escalate to user

### Health Check

```
mcp__codex__ping → { message: "pong" }
```

Run this before the first Codex call in a session.

---

## Deprecated / Retired Models

Do not use these — they are all migrated to `gpt-5.4`:

- `gpt-5.3-codex`
- `gpt-5.2-codex`  
- `gpt-5.1-codex-mini`

---

## Source Repository

Fork: `https://github.com/evelynadriaan/codex-mcp-server`  
Branch: `fix/server-lifecycle`  
Local path: `/media/nicolai/ThickGbs/Laudio/codex-mcp-server`
