/**
 * Read-ACL gate for the knowledge hub.
 *
 * The hub itself is unauthenticated (it only reads x-tdai-service-id). Per-resource read access is
 * enforced by delegating to memory-core's checkPermission — the ONE authoritative decision point
 * (owner -> team-membership -> visibility -> role-default -> ACL). code_graph_id / wiki_id are the
 * same value as the memory-core asset_id, so no id mapping is needed.
 *
 * includeCode (full source) is treated as a DISTINCT, stricter tier: until a dedicated source-tier
 * permission exists in the grant model it is allowed for the OWNER ONLY. A generic 'use' grant is
 * intentionally NOT accepted as a source-tier proxy ('use' means "an agent may execute/bind this
 * asset", not "read its source" — overloading it would leak full source to execution grantees). This
 * closes the Hole-B cross-team leak: the old check let any 'acl:*' read grant (incl. a cross-team
 * team-read) serve full source. Symbols/signatures (read tier) remain available to any read grant.
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

async function aclCheck(userKey: string, assetId: string, serviceId: string, action: string = "read"): Promise<CheckResult> {
  try {
    const res = await fetch(`${MEMORY_CORE_URL}/v3/meta/acl/check`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-tdai-service-id": serviceId,
        "x-tdai-user-key": MEMORY_CORE_KEY,
      },
      body: JSON.stringify({ user_key: userKey, asset_id: assetId, action }),
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

  if (opts?.requireOwner && reason !== "owner") {
    // Full source (includeCode) is a DISTINCT, stricter tier. Until a dedicated source-tier
    // permission ('include_code'/'read_source') exists in the grant model, gate it on OWNER ONLY.
    // We deliberately do NOT accept a generic 'use' grant as a source-tier proxy: 'use' means "an
    // agent may execute/bind this asset", NOT "read its source" — overloading it would leak full
    // source to execution grantees (council STOP, 2026-08-13). The old `reason.startsWith("acl:")`
    // check let ANY read grant (incl. a cross-team team-read) through → cross-team full-source leak
    // (Hole B). A real source-tier permission must land BEFORE cross-team full-source sharing (P5);
    // plain read grants continue to receive only symbols/signatures (requireOwner:false).
    return c.json(
      wrapError(403, "permission denied: full source (includeCode) requires ownership"),
      403,
    );
  }
  return null;
}

/**
 * Boolean read check for a single asset (Pillar-4 per-page ACL). Same delegation as enforceReadAcl
 * but returns true/false instead of a Response, so callers can FILTER a set of pages (search hits /
 * page refs) fail-closed: when read-ACL is off it allows (single-tenant dev); a missing user key or
 * any non-allow / unreachable verdict denies.
 */
export async function isReadAllowed(c: Context, assetId: string): Promise<boolean> {
  const userKey =
    (c.req.header("x-tdai-user-key") || "").trim() ||
    (c.req.header("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  const serviceId = c.req.header("x-tdai-service-id") || "default";
  return isReadAllowedFor(userKey, assetId, serviceId);
}

/**
 * Same as isReadAllowed but the caller identity is passed directly — for callers that don't have the
 * Hono Context (e.g. the MCP tool executor). Fail-closed: read-ACL off → true (single-tenant dev);
 * missing key or any non-allow / unreachable verdict → false.
 */
export async function isReadAllowedFor(userKey: string, assetId: string, serviceId = "default"): Promise<boolean> {
  if (!readAclEnabled()) return true;
  if (!userKey) return false;
  const { allowed } = await aclCheck(userKey, assetId, serviceId);
  return allowed;
}
