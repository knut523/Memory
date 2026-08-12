/**
 * Read-ACL gate for the knowledge hub.
 *
 * The hub itself is unauthenticated (it only reads x-tdai-service-id). Per-resource read access is
 * enforced by delegating to memory-core's checkPermission — the ONE authoritative decision point
 * (owner -> team-membership -> visibility -> role-default -> ACL). code_graph_id / wiki_id are the
 * same value as the memory-core asset_id, so no id mapping is needed.
 *
 * includeCode (full source) is treated as a DISTINCT, stricter grant: it is allowed only when the
 * caller is the OWNER or holds an explicit ACL/grant on the resource — never by team role-default.
 * We derive that from the check's `reason` (owner / acl:*), so no separate permission is required.
 *
 * Fails CLOSED: no user key, memory-core unreachable, or a non-allow verdict => the read is denied.
 * Disabled only when MEMORY_CORE_URL is unset (local dev), so existing single-tenant setups are
 * unaffected until explicitly configured.
 */
import type { Context } from "hono";
import { wrapError } from "./api-helpers.js";
import { createLogger } from "./logger.js";

const log = createLogger("read-acl");

const MEMORY_CORE_URL = (process.env.MEMORY_CORE_URL || process.env.REMOTE_INSTANCE_URL || "").replace(/\/+$/, "");
const MEMORY_CORE_KEY = process.env.MEMORY_CORE_KEY || "";

export function readAclEnabled(): boolean {
  return !!MEMORY_CORE_URL && !!MEMORY_CORE_KEY;
}

interface CheckResult { allowed: boolean; reason: string }

async function aclCheck(userKey: string, assetId: string, serviceId: string): Promise<CheckResult> {
  try {
    const res = await fetch(`${MEMORY_CORE_URL}/v3/meta/acl/check`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-tdai-service-id": serviceId,
        "x-tdai-user-key": MEMORY_CORE_KEY,
      },
      body: JSON.stringify({ user_key: userKey, asset_id: assetId, action: "read" }),
      signal: AbortSignal.timeout(4000),
    });
    const json = (await res.json().catch(() => null)) as
      | { code?: number; data?: { allowed?: boolean; reason?: string } }
      | null;
    if (!res.ok || !json || json.code !== 0 || !json.data) {
      log.warn(`acl check unavailable for ${assetId} (status ${res.status}) — denying`);
      return { allowed: false, reason: "acl_unavailable" };
    }
    return { allowed: !!json.data.allowed, reason: json.data.reason ?? "" };
  } catch (e) {
    log.warn(`acl check error for ${assetId}: ${(e as Error).message} — denying`);
    return { allowed: false, reason: "acl_error" };
  }
}

/**
 * Returns a denial Response to short-circuit the handler, or null when the read is allowed.
 * When opts.requireOwner is set (includeCode / full-source), a plain team-member read is NOT enough.
 */
export async function enforceReadAcl(
  c: Context,
  assetId: string,
  opts?: { requireOwner?: boolean },
): Promise<Response | null> {
  if (!readAclEnabled()) return null; // not configured (local dev) — behave as before
  const userKey =
    (c.req.header("x-tdai-user-key") || "").trim() ||
    (c.req.header("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (!userKey) return c.json(wrapError(403, "permission denied: authentication required"), 403);
  const serviceId = c.req.header("x-tdai-service-id") || "default";

  const { allowed, reason } = await aclCheck(userKey, assetId, serviceId);
  if (!allowed) return c.json(wrapError(403, `permission denied: ${reason || "not_permitted"}`), 403);

  if (opts?.requireOwner && !(reason === "owner" || reason.startsWith("acl:"))) {
    return c.json(
      wrapError(403, "permission denied: full source (includeCode) requires owner or an explicit grant"),
      403,
    );
  }
  return null;
}
