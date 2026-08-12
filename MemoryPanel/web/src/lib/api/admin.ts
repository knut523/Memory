/**
 * Admin API client — folds the former standalone :8901 admin UI ("two links") into the panel.
 *
 * These routes live at `/api/v1/admin/*` (NOT under the `/meta` proxy — they mix GET/POST and are
 * proxied server-side to the admin server with a token the browser never sees). The panel backend
 * gates every one of them SERVER-SIDE on the caller's `user_type === "system_admin"` (see
 * src/panel/http/routes/admin.ts); this client only carries the same session headers every other
 * panel call uses. A non-admin gets 403 here even though the nav item is hidden for them.
 */
import { request, ApiError } from './base';
import { getPanelSession } from '../panelSession';

const ADMIN_PREFIX = '/api/v1/admin';

function authHeaders(): Record<string, string> {
  const session = getPanelSession();
  if (!session) throw new ApiError(401, 'Unauthorized', 'no active panel session');
  return {
    'X-Tdai-Service-Id': session.instanceId,
    'X-Tdai-User-Key': session.userKey,
  };
}

/** A pending connect request awaiting an admin's approval. */
export interface PendingPairing {
  user_code: string;
  client?: string;
  kind?: string;
  json?: unknown;
}

/** One tamper-evident provenance-ledger event. */
export interface AuditEvent {
  seq: number;
  ts: number;
  type?: string;
  action?: string;
  actor_id?: string | null;
  actor_name?: string | null;
  target_id?: string | null;
  target_type?: string | null;
  crud?: string;
  group?: string | null;
  data?: Record<string, unknown>;
  hash?: string;
}

/** A question the team's memory can't answer (from study-pack self-study). */
export interface KnowledgeGap {
  source_id: string;
  source_type: string;
  gap: string;
}

export interface VerifyResult {
  ok: boolean;
  events: number;
  tip?: string;
}

export async function fetchPending(): Promise<PendingPairing[]> {
  const r = await request<{ pending?: PendingPairing[] }>('GET', `${ADMIN_PREFIX}/pending`, undefined, authHeaders());
  return r.pending ?? [];
}

export async function approvePairing(userCode: string): Promise<void> {
  await request('POST', `${ADMIN_PREFIX}/approve`, { user_code: userCode }, authHeaders());
}

export async function revokePairing(userCode: string): Promise<void> {
  await request('POST', `${ADMIN_PREFIX}/revoke`, { user_code: userCode }, authHeaders());
}

export async function fetchAudit(limit = 50): Promise<AuditEvent[]> {
  const r = await request<{ events?: AuditEvent[] }>(
    'GET',
    `${ADMIN_PREFIX}/audit?limit=${encodeURIComponent(String(limit))}`,
    undefined,
    authHeaders(),
  );
  return r.events ?? [];
}

export async function fetchVerify(): Promise<VerifyResult> {
  return request<VerifyResult>('GET', `${ADMIN_PREFIX}/verify`, undefined, authHeaders());
}

export async function fetchGaps(): Promise<{ gaps: KnowledgeGap[]; sources: number }> {
  const r = await request<{ gaps?: KnowledgeGap[]; sources?: number }>(
    'GET',
    `${ADMIN_PREFIX}/gaps`,
    undefined,
    authHeaders(),
  );
  return { gaps: r.gaps ?? [], sources: r.sources ?? 0 };
}
