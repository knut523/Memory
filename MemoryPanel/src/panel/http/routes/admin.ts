/**
 * Admin section, folded into the panel (was a separate app on :8901 — "two links").
 *
 * SECURITY (council requirement): access is gated SERVER-SIDE on the caller's
 * `user_type === "system_admin"` — a client-side nav hide is NOT a boundary. The admin-server URL
 * and its X-Admin-Token stay server-side (env); the browser never receives the admin token. Every
 * route resolves the caller, requires admin, then proxies to the admin server. Fail-closed: any
 * doubt about the caller's role -> 403.
 */
import type { Context, Hono } from "hono";
import type { PanelDeps } from "../../panel-deps.js";
import { validatePanelMetaHeaders } from "../middleware/validate-panel-headers.js";

const ADMIN_URL = (process.env.TDAI_ADMIN_URL || "http://172.17.0.1:8901").replace(/\/$/, "");
const ADMIN_TOKEN = process.env.TDAI_ADMIN_TOKEN || "";

/**
 * Resolve the caller's user_id from the `sk-mem-…` user key the panel already carries in
 * `panelMeta.userKey` (the same header every other panel route authenticates with — the browser
 * NEVER sends a raw user_id). Mirrors resolveCallerUserId() in knowledge/common.ts. Returns null
 * on any failure (fail-closed).
 */
async function resolveCallerUserId(deps: PanelDeps, ctx: unknown, userKey: string): Promise<string | null> {
  if (!userKey) return null;
  try {
    const env = await deps.metaKernel.invoke("auth/verify", { user_key: userKey }, ctx as never);
    if (env?.code !== 0) return null;
    const data = env.data as { valid?: boolean; user?: { user_id?: string } } | null;
    if (!data?.valid) return null;
    const uid = data.user?.user_id;
    return typeof uid === "string" && uid.length > 0 ? uid : null;
  } catch {
    return null;
  }
}

/** True only if the given user exists and is a system_admin. Fail-closed on any error. */
async function userIsSystemAdmin(deps: PanelDeps, ctx: unknown, userId: string): Promise<boolean> {
  if (!userId) return false;
  try {
    const env = await deps.metaKernel.invoke("user/get", { user_id: userId }, ctx as never);
    const userType = (env?.data as { user_type?: string } | undefined)?.user_type;
    return env?.code === 0 && userType === "system_admin";
  } catch {
    return false;
  }
}

async function proxyAdmin(
  path: string,
  method: string,
  body?: unknown,
): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`${ADMIN_URL}${path}`, {
    method,
    headers: { "X-Admin-Token": ADMIN_TOKEN, "Content-Type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    /* non-JSON admin-server response */
  }
  return { status: res.status, json };
}

export function registerAdminRoutes(api: Hono, deps: PanelDeps): void {
  const mw = validatePanelMetaHeaders(deps);

  // Resolve caller from panelMeta.userKey (auth/verify -> user_id -> user/get.user_type) and require
  // system_admin. The validatePanelMetaHeaders middleware has already put the verified userKey on
  // panelMeta; the browser never sends a raw user_id.
  const requireAdmin = async (
    c: Context,
  ): Promise<{ ok: true; ctx: unknown } | { ok: false }> => {
    const ctx = (c.get("panelMeta") ?? {}) as { userKey?: string };
    const userId = await resolveCallerUserId(deps, ctx, ctx.userKey?.trim() || "");
    if (!userId || !(await userIsSystemAdmin(deps, ctx, userId))) return { ok: false };
    return { ok: true, ctx };
  };

  api.get("/admin/pending", mw, async (c) => {
    if (!(await requireAdmin(c)).ok) return c.json({ code: 403, message: "admin only" }, 403);
    const r = await proxyAdmin("/api/pending", "GET");
    return c.json(r.json as never, r.status as never);
  });

  api.post("/admin/approve", mw, async (c) => {
    if (!(await requireAdmin(c)).ok) return c.json({ code: 403, message: "admin only" }, 403);
    const body = await c.req.json().catch(() => ({}));
    const r = await proxyAdmin("/api/approve", "POST", body);
    return c.json(r.json as never, r.status as never);
  });

  api.post("/admin/revoke", mw, async (c) => {
    if (!(await requireAdmin(c)).ok) return c.json({ code: 403, message: "admin only" }, 403);
    const body = await c.req.json().catch(() => ({}));
    const r = await proxyAdmin("/api/revoke", "POST", body);
    return c.json(r.json as never, r.status as never);
  });

  api.get("/admin/audit", mw, async (c) => {
    if (!(await requireAdmin(c)).ok) return c.json({ code: 403, message: "admin only" }, 403);
    const r = await proxyAdmin("/api/audit" + new URL(c.req.url).search, "GET");
    return c.json(r.json as never, r.status as never);
  });

  api.get("/admin/verify", mw, async (c) => {
    if (!(await requireAdmin(c)).ok) return c.json({ code: 403, message: "admin only" }, 403);
    const r = await proxyAdmin("/api/verify", "GET");
    return c.json(r.json as never, r.status as never);
  });

  api.get("/admin/gaps", mw, async (c) => {
    if (!(await requireAdmin(c)).ok) return c.json({ code: 403, message: "admin only" }, 403);
    const r = await proxyAdmin("/api/gaps", "GET");
    return c.json(r.json as never, r.status as never);
  });
}
