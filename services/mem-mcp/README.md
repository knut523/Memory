# mem-mcp — tdai memory over MCP (for remote AI coders)

A tiny, self-contained **Streamable-HTTP MCP server** that gives a remote AI coder (Claude Code,
Cursor, any MCP `--transport http` client) two tools backed by the team's tdai memory:

- **`memory_recall(query, limit?)`** — semantic search over the team's conversation memory
- **`memory_add(content, session_id?)`** — save a fact/decision/note into the team's memory

It is a thin wrapper over memory-core's `/v2/conversation/{add,search}`. Unlike the LLM memory
**proxy** (which captures memory only when the coder's *model calls* route through it — the jcode
path), this MCP server works for coders whose model you can't reroute (e.g. Claude Code stays on
Claude): the coder just gets memory **tools** it calls explicitly.

## Security model (do not weaken)

- The client presents `Authorization: Bearer <member_key>` (the `api_key` from its pairing config).
- On **every** tool call the server verifies that key against core (`/v3/meta/auth/verify`) and derives
  `user_id` from the verified response. **Client-sent identity headers are never trusted for scope.**
- `team_id` is **pinned** to `MEM_TEAM`. A caller can only read/write as its verified self, in that team.
- The core credential (`CORE_KEY`) is held server-side, never handed to the coder.

> This process is currently the sole tenant-isolation gate — see `mem_mcp.py:_ids()`. Recommended
> hardening before relying on it beyond a trusted team: (1) give it a **team-scoped** service key
> instead of the global admin key, (2) also check the key's membership includes `MEM_TEAM`
> (`auth/verify` returns no team today), (3) a contract test that `_ids()` never reads client headers.

## Run

```bash
docker run -d --name tdai-mem-mcp \
  --network tdai-memory-stack \
  -p 172.17.0.1:8710:8710 \
  --restart unless-stopped \
  -v "$PWD/mem_mcp.py":/app/mem_mcp.py:ro \
  -e CORE_URL="http://memory-core:8420" \
  -e CORE_KEY="<a memory-core service key that can add/search for MEM_TEAM>" \
  -e MEM_TEAM="<your team id>" \
  -e CORE_SERVICE_ID="default" \
  python:3.12-slim python /app/mem_mcp.py
```

Expose it over TLS behind your reverse proxy (nginx location → `http://172.17.0.1:8710/`,
`proxy_buffering off`). Health: `GET /health` → `{"ok": true}`. A plain `GET /` returns 405 —
MCP is POST JSON-RPC, that's expected.

## Connect a coder (Claude Code)

```bash
claude mcp add --transport http tdai-memory \
  https://<your-host>/mem-mcp/ \
  --header "Authorization: Bearer <api_key from ~/.tdai-memory.json>"
```

The coder now has `memory_recall` / `memory_add`. Say "remember this for the team: …" → it calls
`memory_add`; ask something that depends on past context → it calls `memory_recall`.

## Scoping note

Memory is addressed per `(team, user)`. A coder recalls **its own** writes within the team. If you
want **team-wide shared** recall (every member sees everyone's memory), search with `team_id` only
(omit `user_id`) — a one-line change in `_call_tool`.
