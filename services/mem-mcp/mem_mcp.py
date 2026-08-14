#!/usr/bin/env python3
"""
tdai memory MCP server (Streamable-HTTP, self-contained stdlib).

Gives a remote AI coder (Claude Code etc.) two memory tools over the MCP protocol:
  - memory_add(content, session_id?)   -> writes a message into the team's conversation memory
  - memory_recall(query, limit?)        -> semantic search over the team's conversation memory

It is a thin wrapper over memory-core's /v2/conversation/{add,search} (contract verified live: Bearer
<core key> + x-tdai-service-id + idFields).

SECURITY MODEL — do not weaken:
  * The caller presents Authorization: Bearer <member_key>. On EVERY tools/call the server VERIFIES
    that key against core (/v3/meta/auth/verify) and derives user_id from the verified response.
  * Client-sent identity headers (x-team-id/x-user-id/…) are NOT trusted for scope. team_id is PINNED
    to MEM_TEAM (env). This server is currently the sole tenant-isolation gate — never let user_id or
    team_id be influenced by client headers (see _ids()).
  * The core credential (CORE_KEY) is held server-side, never handed to the coder.

Env:
  CORE_URL        (default http://172.17.0.1:8420)
  CORE_KEY        Bearer key for memory-core (a service key that can write add/search for MEM_TEAM)
  CORE_SERVICE_ID (default "default")  -> x-tdai-service-id
  MEM_TEAM        the team all writes/reads are pinned to
"""
import json, os, urllib.request, urllib.error
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

CORE_URL = os.environ.get("CORE_URL", "http://172.17.0.1:8420").rstrip("/")
CORE_KEY = os.environ.get("CORE_KEY", "")           # server's own credential to call core
SERVICE_ID = os.environ.get("CORE_SERVICE_ID", "default")
MEM_TEAM = os.environ.get("MEM_TEAM", "")           # pinned team; a coder can NEVER write elsewhere
PROTOCOL_VERSION = "2025-06-18"

TOOLS = [
    {
        "name": "memory_add",
        "description": "Save a fact, decision, or note into the team's shared long-term memory so you (and teammates) can recall it in future sessions. Use it whenever the user says 'remember', or when a durable decision/fact is established.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "content": {"type": "string", "description": "The fact/decision/note to remember, as a self-contained sentence."},
                "session_id": {"type": "string", "description": "Optional grouping id; omit to auto-group."},
            },
            "required": ["content"],
        },
    },
    {
        "name": "memory_recall",
        "description": "Semantic search over the team's shared long-term memory. Use it before answering anything that may depend on past work, decisions, people, or the user's stated preferences.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "What to look for."},
                "limit": {"type": "integer", "description": "Max hits (default 5).", "default": 5},
            },
            "required": ["query"],
        },
    },
]


def _core(path: str, body: dict) -> dict:
    req = urllib.request.Request(
        CORE_URL + path,
        data=json.dumps(body).encode(),
        method="POST",
        headers={
            "Authorization": "Bearer " + CORE_KEY,
            "x-tdai-service-id": SERVICE_ID,
            "Content-Type": "application/json",
        },
    )
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.loads(r.read().decode())


def _verify(member_key: str) -> str | None:
    """Verify the coder's member key against core → return the REAL user_id (or None if invalid).
    Identity is derived from the verified key, never trusted from client-sent headers."""
    if not member_key:
        return None
    try:
        r = _core("/v3/meta/auth/verify", {"user_key": member_key})
        if r.get("code") == 0 and (r.get("data") or {}).get("valid"):
            return ((r.get("data") or {}).get("user") or {}).get("user_id")
    except Exception:
        return None
    return None


def _ids(headers) -> dict:
    """Caller identity: user_id from the VERIFIED member key (Authorization Bearer); team pinned by env.
    A coder can only write as itself, and only into MEM_TEAM — client headers are not trusted for scope."""
    auth = headers.get("Authorization", "")
    member_key = auth[7:] if auth.startswith("Bearer ") else ""
    user_id = _verify(member_key)
    if not user_id:
        raise PermissionError("invalid or missing member key")
    out = {"user_id": user_id}
    if MEM_TEAM:
        out["team_id"] = MEM_TEAM
    return out


def _call_tool(name: str, args: dict, headers) -> str:
    ids = _ids(headers)
    if name == "memory_add":
        body = {**ids, "session_id": args.get("session_id") or "mcp", "messages": [{"role": "user", "content": args["content"]}]}
        r = _core("/v2/conversation/add", body)
        if r.get("code") == 0:
            return "Saved to team memory (id %s)." % ((r.get("data") or {}).get("accepted_ids", ["?"])[0])
        return "Save failed: %s" % r.get("message")
    if name == "memory_recall":
        body = {**ids, "query": args["query"], "limit": int(args.get("limit") or 5)}
        r = _core("/v2/conversation/search", body)
        msgs = (r.get("data") or {}).get("messages", []) if r.get("code") == 0 else []
        if not msgs:
            return "No matching memory found."
        return "\n".join("- %s" % m.get("content", "") for m in msgs)
    raise ValueError("unknown tool: " + name)


def _rpc(msg: dict, headers) -> dict | None:
    mid = msg.get("id")
    method = msg.get("method")
    if method == "initialize":
        return {"jsonrpc": "2.0", "id": mid, "result": {
            "protocolVersion": PROTOCOL_VERSION,
            "capabilities": {"tools": {}},
            "serverInfo": {"name": "tdai-memory", "version": "0.1.0"},
        }}
    if method in ("notifications/initialized", "notifications/cancelled"):
        return None  # notification, no response
    if method == "tools/list":
        return {"jsonrpc": "2.0", "id": mid, "result": {"tools": TOOLS}}
    if method == "tools/call":
        p = msg.get("params") or {}
        try:
            text = _call_tool(p.get("name"), p.get("arguments") or {}, headers)
            return {"jsonrpc": "2.0", "id": mid, "result": {"content": [{"type": "text", "text": text}]}}
        except Exception as e:
            return {"jsonrpc": "2.0", "id": mid, "result": {"content": [{"type": "text", "text": "error: %s" % e}], "isError": True}}
    if method == "ping":
        return {"jsonrpc": "2.0", "id": mid, "result": {}}
    return {"jsonrpc": "2.0", "id": mid, "error": {"code": -32601, "message": "method not found: %s" % method}}


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        # health + (MCP GET opens an SSE stream; we don't push server-initiated msgs, so 405 is fine)
        if self.path == "/health":
            self._send(200, {"ok": True})
        else:
            self.send_response(405); self.end_headers()

    def do_POST(self):
        ln = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(ln) if ln else b""
        try:
            payload = json.loads(raw or b"{}")
        except Exception:
            self._send(400, {"error": "bad json"}); return
        batch = payload if isinstance(payload, list) else [payload]
        out = [r for r in (_rpc(m, self.headers) for m in batch) if r is not None]
        if not out:
            self.send_response(202); self.end_headers(); return  # notifications only
        self._send(200, out[0] if len(out) == 1 else out)

    def _send(self, code, obj):
        b = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def log_message(self, *a):
        pass


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8710"))
    ThreadingHTTPServer(("0.0.0.0", port), Handler).serve_forever()
