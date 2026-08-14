/**
 * core-meta.ts — thin client to memory-core's /v3/meta/* for Pillar-4 per-page sharing.
 *
 * Forwards the CALLER's user key (x-tdai-user-key) so memory-core authorizes the write AS that user
 * (the wiki owner) — the hub never elevates. Fails soft (returns {ok:false, ...}); the route decides
 * the HTTP response. Same MEMORY_CORE_URL contract as read-acl.ts.
 */
const CORE = (process.env.MEMORY_CORE_URL || process.env.REMOTE_INSTANCE_URL || "").replace(/\/+$/, "");

export function coreMetaEnabled(): boolean {
  return !!CORE;
}

export interface CoreResult<T = unknown> {
  ok: boolean;
  code: number;
  data?: T;
  message?: string;
}

export async function coreMeta<T = unknown>(
  action: string,
  body: unknown,
  userKey: string,
  serviceId: string,
): Promise<CoreResult<T>> {
  if (!CORE) return { ok: false, code: -1, message: "core_not_configured" };
  try {
    const res = await fetch(`${CORE}/v3/meta/${action}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-tdai-service-id": serviceId,
        "x-tdai-user-key": userKey,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
    const json = (await res.json().catch(() => null)) as { code?: number; data?: T; message?: string } | null;
    if (!json) return { ok: false, code: res.status, message: "bad_response" };
    return { ok: json.code === 0, code: json.code ?? res.status, data: json.data, message: json.message };
  } catch (e) {
    return { ok: false, code: -1, message: (e as Error).message };
  }
}
