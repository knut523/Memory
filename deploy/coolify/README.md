# Coolify deployment (this fork)

Deploys the full stack (memory-core + memory-hub + memory-proxy) built from
**this repo's own Dockerfiles** — not the generic `agentmemory/*` images on
Docker Hub, which don't contain this fork's customizations (wiki ACL, admin
console, MCP memory server).

## Why `memory-hub.Dockerfile` instead of `deploy/panel-knowledge-combined/Dockerfile`

The upstream combined Dockerfile expects a synthetic build context with
`panel/` and `knowledge/` at its root, normally produced by
`deploy/panel-knowledge-combined/build.sh` via `rsync`. Coolify's Compose
builder can't run that shell step, so `memory-hub.Dockerfile` is a
repo-root-context variant that copies directly from `MemoryPanel/` and
`MemoryKnowledge/`. Keep the two in sync if the upstream Dockerfile changes.

## Required environment variables (set in the Coolify app, never in git)

| Variable | Used by | Notes |
|---|---|---|
| `MEMORY_LLM_BASE_URL` / `MEMORY_LLM_API_KEY` / `MEMORY_LLM_MODEL` | memory-core, memory-hub | Embedding/summarize/persona-extraction + wiki-ingest LLM |
| `MEMORY_LLM_PROTOCOL` | memory-hub | `openai` (default) or `anthropic` |
| `KNOWLEDGE_PUBLIC_BASE_URL` | memory-hub | Must be externally reachable, must include `/v3` — set to `https://<memory-knowledge domain>/v3` |
| `PROXY_UPSTREAM_URL` / `PROXY_UPSTREAM_API_KEY` | memory-proxy | The upstream LLM a coding agent's requests actually get forwarded to |
| `MEMORY_PROXY_PUBLIC_URL` | memory-hub (optional) | Public proxy URL shown on the Panel's "client access" card |

## Memory limits

Every service has an explicit `deploy.resources.limits.memory` and a reduced
`NODE_OPTIONS=--max-old-space-size=...` (the upstream Dockerfiles default to
1.5GB heap per Node process, sized for a bigger box). If a service is
genuinely memory-pressured in practice, raise its limit — don't remove it.

## First-deploy admin bootstrap

The `memory-init` one-shot service creates the `system_admin` Panel login
after `memory-core` is healthy. Read the generated `username`/`user_key` from
`memory-init`'s container logs in the Coolify dashboard — it's only ever
printed once. If you lose it, reset the `memory-core-data` volume and
redeploy to re-run init.

## Proxy full-stack mode

`memory-proxy` runs with `auth` + `sessionInit` + `tdai` memory injection all
enabled. This requires `memory-core`'s `TDAI_GATEWAY_API_KEY` to stay empty —
the proxy's `/v3/meta/auth/verify` call doesn't send a Bearer header (upstream
bug), so a non-empty core key breaks auth entirely.
