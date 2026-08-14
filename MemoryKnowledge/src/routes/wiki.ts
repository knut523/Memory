/**
 * Wiki Routes — 15 endpoints (Hono rewrite).
 *
 * Asset (5): create / get / list / delete / ingest
 * File (8): raw/{ls,read,write,rm} + page/{ls,read,write,rm}
 * Derived (2): graph / search
 *
 * All POST, unified ApiResponseEnvelope.
 * Routes are defined WITHOUT /v2 prefix — the prefix is applied once at server.ts mount level.
 *
 * Multi-tenancy (001): `service_id` is REQUIRED via the `x-tdai-service-id` header on
 * EVERY endpoint (unified with the kernel routing key). id-only endpoints resolve
 * `getById(service_id, wiki_id)` so a foreign tenant's resource is never exposed (R1).
 * service_id / wiki_id are validated as safe path segments before use (R5).
 */

import { Hono } from "hono";

import type { WikiService } from "../store/index.js";
import type { WikiSourceManager } from "../engines/wiki/index.js";
import type { WikiStatus } from "../store/index.js";
import {
  extractIdFields,
  isValidIdSegment,
  wrapOk,
  wrapError,
  toWikiDetail,
  type BatchDeleteResult,
} from "../api-helpers.js";
import { enforceReadAcl, isReadAllowed } from "../read-acl.js";
import { coreMeta } from "../core-meta.js";
import { pageAssetId } from "../store/wiki-service.js";
import { idFromPath } from "../engines/wiki/manager.js";

export interface WikiRouteDeps {
  wikiService: WikiService;
  wikiMgr: WikiSourceManager;
  /** Public base URL for service_url; should already include the API prefix (e.g. http://host:8421/v3). */
  publicBaseUrl: string;
}

/** Handle WriteOutcome error codes → HTTP response. Returns Response if handled, null otherwise. */
function maybeWriteError(outcome: unknown): Response | null {
  if (outcome === null) return Response.json(wrapError(404, "wiki not found"), { status: 404 });
  if (outcome === "processing") return Response.json(wrapError(409, "wiki is processing; cannot write/delete"), { status: 409 });
  if (outcome === "invalid_path") return Response.json(wrapError(400, "invalid path: traversal detected"), { status: 400 });
  if (outcome === "forbidden_path") return Response.json(wrapError(400, "forbidden path (structural file or outside wiki/)"), { status: 400 });
  if (outcome === "too_large") return Response.json(wrapError(413, "content exceeds size limit"), { status: 413 });
  return null;
}

export function createWikiRoutes(deps: WikiRouteDeps): Hono {
  const app = new Hono();
  const { wikiService, wikiMgr, publicBaseUrl } = deps;

  // ═══════════════════ Asset Layer ═══════════════════

  // ── id-only (service_id + wiki_id) ──

  app.post("/get", async (c) => {
    const body = await c.req.json<Record<string, unknown>>();
    const serviceId = c.req.header("x-tdai-service-id");
    if (!isValidIdSegment(serviceId)) return c.json(wrapError(400, "x-tdai-service-id header is required"), 400);
    const wikiId = body.wiki_id;
    if (!isValidIdSegment(wikiId)) return c.json(wrapError(400, "wiki_id is required"), 400);

    const row = wikiService.getById(serviceId, wikiId);
    if (!row) return c.json(wrapError(404, "wiki not found"), 404);
    return c.json(wrapOk(toWikiDetail(row)));
  });

  app.post("/ingest", async (c) => {
    const body = await c.req.json<Record<string, unknown>>();
    const serviceId = c.req.header("x-tdai-service-id");
    if (!isValidIdSegment(serviceId)) return c.json(wrapError(400, "x-tdai-service-id header is required"), 400);
    const wikiId = body.wiki_id;
    if (!isValidIdSegment(wikiId)) return c.json(wrapError(400, "wiki_id is required"), 400);
    const requesterUserId = typeof body.user_id === "string" && body.user_id ? body.user_id : undefined;

    const row = wikiService.getById(serviceId, wikiId);
    if (!row) return c.json(wrapError(404, "wiki not found"), 404);

    // 空 wiki 禁止 ingest：无源文件时拒绝（避免静默成功 pageCount=0）
    const sources = wikiService.rawLs(serviceId, row.team_id, wikiId);
    if (!sources || sources.length === 0) {
      return c.json(wrapError(400, "wiki has no source files, upload before ingest"), 400);
    }

    const result = wikiService.ingest(serviceId, row.team_id, wikiId, requesterUserId);
    if (result.kind === "not_found") return c.json(wrapError(404, "wiki not found"), 404);
    if (result.kind === "busy") {
      // 并发拒绝：干净最小的 409 响应体（调用方用 code 判断，不 parse message）。
      return c.json({ code: 409, message: "busy", data: { status: result.status, step: result.step } }, 409);
    }
    return c.json(wrapOk({ wiki_id: result.row.wiki_id, status: result.row.status }), 202);
  });

  app.post("/delete", async (c) => {
    const body = await c.req.json<Record<string, unknown>>();
    const serviceId = c.req.header("x-tdai-service-id");
    if (!isValidIdSegment(serviceId)) return c.json(wrapError(400, "x-tdai-service-id header is required"), 400);
    const wikiIds = body.wiki_ids;
    if (!Array.isArray(wikiIds) || wikiIds.length === 0) {
      return c.json(wrapError(400, "wiki_ids is required (non-empty array)"), 400);
    }
    if (wikiIds.length > 100) {
      return c.json(wrapError(400, "wiki_ids exceeds max 100"), 400);
    }

    const result: BatchDeleteResult = { deleted_ids: [], failed: [] };
    for (const id of wikiIds) {
      if (!isValidIdSegment(id)) {
        result.failed.push({ id: String(id), reason: "invalid id" });
        continue;
      }
      const row = wikiService.getById(serviceId, id);
      if (!row) {
        result.failed.push({ id, reason: "not found" });
        continue;
      }
      // Capture per-page overrides BEFORE delete (it drops the row + its page_share map) — council #7.
      const gcShares = wikiService.getPageShare(serviceId, id);
      const ok = wikiService.delete(serviceId, row.team_id, id);
      if (ok) {
        // wiki engine manager 注册清理仍由路由负责（wikiMgr 未注入 service）；
        // 连接/元数据/磁盘四类清理已在 service.cleanupResources 内完成。
        try { wikiMgr.remove(id); } catch (err) { console.warn(`[wiki] wikiMgr.remove(${id}) failed:`, err); }
        // Per-page ACL lifecycle: delete this wiki's page-assets so none orphan in memory-core.
        const gcKey = (c.req.header("x-tdai-user-key") || "").trim();
        if (gcKey) {
          for (const entry of Object.values(gcShares)) {
            await coreMeta("asset/delete", { asset_ids: [pageAssetId(entry.uuid)] }, gcKey, serviceId);
          }
        }
        result.deleted_ids.push(id);
      } else {
        result.failed.push({ id, reason: "delete failed" });
      }
    }
    return c.json(wrapOk(result));
  });

  app.post("/update-meta", async (c) => {
    const body = await c.req.json<Record<string, unknown>>();
    const serviceId = c.req.header("x-tdai-service-id");
    if (!isValidIdSegment(serviceId)) return c.json(wrapError(400, "x-tdai-service-id header is required"), 400);
    const wikiId = body.wiki_id;
    if (!isValidIdSegment(wikiId)) return c.json(wrapError(400, "wiki_id is required"), 400);

    const patch: { name?: string; summary?: string | null } = {};
    if (typeof body.name === "string" && body.name) patch.name = body.name;
    if (body.summary !== undefined) {
      patch.summary = typeof body.summary === "string" ? body.summary : null;
    }
    if (!patch.name && patch.summary === undefined) {
      return c.json(wrapError(400, "at least one of name/summary must be provided"), 400);
    }

    const updated = wikiService.updateMeta(serviceId, wikiId, patch);
    if (!updated) return c.json(wrapError(404, "wiki not found"), 404);
    return c.json(wrapOk(toWikiDetail(updated)));
  });

  // Set (or clear) one folder's description. folder_path is a page-path directory (e.g. "runbooks");
  // description="" or omitted clears it. Folders themselves stay derived from page paths.
  app.post("/folder-meta/set", async (c) => {
    const body = await c.req.json<Record<string, unknown>>();
    const serviceId = c.req.header("x-tdai-service-id");
    if (!isValidIdSegment(serviceId)) return c.json(wrapError(400, "x-tdai-service-id header is required"), 400);
    const wikiId = body.wiki_id;
    if (!isValidIdSegment(wikiId)) return c.json(wrapError(400, "wiki_id is required"), 400);
    const folderPath = typeof body.folder_path === "string" ? body.folder_path.trim() : "";
    if (!folderPath) return c.json(wrapError(400, "folder_path is required"), 400);
    const description = typeof body.description === "string" ? body.description : null;

    const updated = wikiService.setFolderMeta(serviceId, wikiId, folderPath, description);
    if (!updated) return c.json(wrapError(404, "wiki not found"), 404);
    return c.json(wrapOk(toWikiDetail(updated)));
  });

  // Per-page sharing (Pillar-4): set one page's visibility (private|restricted|team) or clear it
  // (visibility=null → the page inherits the wiki). ONLY the wiki owner may set page access. The page
  // becomes its own memory-core asset (wpage_<uuid>) whose visibility is clamped to be no more
  // permissive than the wiki's (fail-closed intersection). Clearing deletes the page-asset.
  app.post("/page/share", async (c) => {
    const body = await c.req.json<Record<string, unknown>>();
    const serviceId = c.req.header("x-tdai-service-id");
    if (!isValidIdSegment(serviceId)) return c.json(wrapError(400, "x-tdai-service-id header is required"), 400);
    const callerKey = (c.req.header("x-tdai-user-key") || "").trim();
    if (!callerKey) return c.json(wrapError(403, "permission denied: authentication required"), 403);
    const wikiId = body.wiki_id;
    if (!isValidIdSegment(wikiId)) return c.json(wrapError(400, "wiki_id is required"), 400);
    const ref = typeof body.ref === "string" ? body.ref.trim() : "";
    if (!ref) return c.json(wrapError(400, "ref (page relPath) is required"), 400);
    const VIS = ["private", "restricted", "team"] as const;
    const visRaw = body.visibility;
    const visibility: string | null | undefined =
      visRaw === null ? null : typeof visRaw === "string" && (VIS as readonly string[]).includes(visRaw) ? visRaw : undefined;
    if (visibility === undefined) {
      return c.json(wrapError(400, "visibility must be one of private|restricted|team, or null to clear"), 400);
    }

    const row = wikiService.getById(serviceId, wikiId);
    if (!row) return c.json(wrapError(404, "wiki not found"), 404);
    // AUTHORITATIVE owner + visibility live on the memory-core asset (the KS-local row.owner_user_id is
    // null for older wikis, so we must NOT gate on it). Fetch both in one call.
    const wikiAsset = await coreMeta<{ owner_user_id?: string; visibility?: string }>(
      "asset/get",
      { asset_id: wikiId },
      callerKey,
      serviceId,
    );
    const wikiOwner = wikiAsset.data?.owner_user_id;
    if (!wikiAsset.ok || !wikiOwner) {
      return c.json(wrapError(409, "cannot determine wiki owner; cannot set page access"), 409);
    }

    // Only the wiki owner may set page-level access (council #5): verify caller identity against core.
    const who = await coreMeta<{ user?: { user_id?: string } }>("auth/verify", { user_key: callerKey }, callerKey, serviceId);
    const callerId = who.data?.user?.user_id;
    if (!who.ok || !callerId) return c.json(wrapError(403, "permission denied: could not verify caller"), 403);
    if (callerId !== wikiOwner) {
      return c.json(wrapError(403, "permission denied: only the wiki owner can set page access"), 403);
    }

    // Clamp: a page may not be MORE visible than its wiki (fail-closed intersection, council #4).
    if (visibility !== null) {
      if (typeof wikiAsset.data?.visibility !== "string") {
        return c.json(wrapError(409, "cannot determine wiki visibility to clamp against; refusing to set page access"), 409);
      }
      const rank: Record<string, number> = { private: 0, restricted: 1, team: 2 };
      const wikiVis = wikiAsset.data.visibility;
      if ((rank[visibility] ?? 2) > (rank[wikiVis] ?? 2)) {
        return c.json(wrapError(400, `page cannot be more visible than its wiki (wiki is '${wikiVis}')`), 400);
      }
    }

    // Persist the hub-side mapping (mints/reuses the stable page uuid), keyed by the CANONICAL page
    // id (idFromPath form) so it matches the search-engine id + page/read refs for enforcement.
    const share = wikiService.setPageShare(serviceId, wikiId, idFromPath(ref), visibility);
    if (!share) return c.json(wrapError(404, "wiki not found"), 404);

    // Sync the page-asset into memory-core (as the owner).
    if (visibility === null) {
      if (share.uuid) await coreMeta("asset/delete", { asset_ids: [share.assetId] }, callerKey, serviceId);
      return c.json(wrapOk({ ref, visibility: null }));
    }
    // Create-or-update: update first (cheap when it exists), create if missing.
    const upd = await coreMeta("asset/update", { asset_id: share.assetId, visibility }, callerKey, serviceId);
    if (!upd.ok) {
      const crt = await coreMeta(
        "asset/create",
        {
          asset_id: share.assetId,
          team_id: row.team_id,
          asset_type: "llm_wiki_page",
          name: ref,
          owner_user_id: wikiOwner,
          visibility,
          source_type: "extracted",
        },
        callerKey,
        serviceId,
      );
      if (!crt.ok) {
        // Roll back the hub override so we never leave a deny-all page: without its wpage asset in
        // core, acl/check returns asset_not_available = deny for EVERYONE incl. the owner (council #5).
        wikiService.setPageShare(serviceId, wikiId, idFromPath(ref), null);
        return c.json(wrapError(502, `core sync failed: ${crt.message || upd.message || "unknown"}`), 502);
      }
    }
    return c.json(wrapOk({ ref, visibility, asset_id: share.assetId }));
  });

  // Per-page sharing status for the UI: the current override map { "<pageId>": {uuid, visibility} }.
  // Owner-only — the map reveals which pages are restricted (their existence + visibility).
  app.post("/page/shares", async (c) => {
    const body = await c.req.json<Record<string, unknown>>();
    const serviceId = c.req.header("x-tdai-service-id");
    if (!isValidIdSegment(serviceId)) return c.json(wrapError(400, "x-tdai-service-id header is required"), 400);
    const wikiId = body.wiki_id;
    if (!isValidIdSegment(wikiId)) return c.json(wrapError(400, "wiki_id is required"), 400);
    const row = wikiService.getById(serviceId, wikiId);
    if (!row) return c.json(wrapError(404, "wiki not found"), 404);
    const callerKey = (c.req.header("x-tdai-user-key") || "").trim();
    // Authoritative owner from the core asset (KS-local row.owner_user_id may be null).
    const wikiAsset = await coreMeta<{ owner_user_id?: string }>("asset/get", { asset_id: wikiId }, callerKey, serviceId);
    const who = callerKey
      ? await coreMeta<{ user?: { user_id?: string } }>("auth/verify", { user_key: callerKey }, callerKey, serviceId)
      : null;
    const wikiOwner = wikiAsset.data?.owner_user_id;
    if (!wikiOwner || who?.data?.user?.user_id !== wikiOwner) {
      return c.json(wrapError(403, "permission denied: only the wiki owner can view page sharing"), 403);
    }
    return c.json(wrapOk({ shares: wikiService.getPageShare(serviceId, String(wikiId)) }));
  });

  // ── WITH-IdFields (service_id + team_id) ──

  app.post("/create", async (c) => {
    const body = await c.req.json<Record<string, unknown>>();
    const ids = extractIdFields(c.req.header("x-tdai-service-id"), body);
    if (!ids) return c.json(wrapError(400, "x-tdai-service-id header and team_id are required"), 400);

    const name = body.name;
    if (typeof name !== "string" || !name) return c.json(wrapError(400, "name is required"), 400);

    const { row, existed } = wikiService.create({
      service_id: ids.service_id,
      team_id: ids.team_id,
      name,
      owner_user_id: ids.user_id,
      user_id: ids.user_id,
      agent_id: ids.agent_id,
      task_id: ids.task_id,
    });

    // Persist service_url (tools self-discovery base; resource selected via
    // knowledge_id in request body, so the URL is service-level, not
    // resource-scoped). publicBaseUrl already includes the API prefix; proxy
    // appends `/tools/list` | `/tools/call` directly.
    if (!existed && publicBaseUrl) {
      const serviceUrl = publicBaseUrl;
      const updated = wikiService.updateServiceUrl(ids.service_id, row.wiki_id, serviceUrl);
      if (updated) return c.json(wrapOk(toWikiDetail(updated)), 201);
    }

    return c.json(wrapOk(toWikiDetail(row)), existed ? 200 : 201);
  });

  app.post("/list", async (c) => {
    const body = await c.req.json<Record<string, unknown>>();
    const ids = extractIdFields(c.req.header("x-tdai-service-id"), body);
    if (!ids) return c.json(wrapError(400, "x-tdai-service-id header and team_id are required"), 400);

    const status = typeof body.status === "string" ? (body.status as WikiStatus) : undefined;
    const limit = typeof body.limit === "number" ? body.limit : 20;
    const offset = typeof body.offset === "number" ? body.offset : 0;

    const items = wikiService.list(ids.service_id, ids.team_id, { syncStatus: status, limit, offset });
    const total = wikiService.count(ids.service_id, ids.team_id, status ? { syncStatus: status } : undefined);
    return c.json(wrapOk({ items: items.map(toWikiDetail), total }));
  });

  // ═══════════════════ File Layer raw/* ═══════════════════

  // ── id-only ──

  app.post("/raw/ls", async (c) => {
    const body = await c.req.json<Record<string, unknown>>();
    const serviceId = c.req.header("x-tdai-service-id");
    if (!isValidIdSegment(serviceId)) return c.json(wrapError(400, "x-tdai-service-id header is required"), 400);
    const wikiId = body.wiki_id;
    if (!isValidIdSegment(wikiId)) return c.json(wrapError(400, "wiki_id is required"), 400);

    const rlDenied = await enforceReadAcl(c, String(wikiId));
    if (rlDenied) return rlDenied;

    const row = wikiService.getById(serviceId, wikiId);
    if (!row) return c.json(wrapError(404, "wiki not found"), 404);

    // Per-page ACL (Pillar-4): once any page override exists, raw source listing is owner-only —
    // source filenames can reveal a restricted page's existence (council #3/#8), mirrors raw/read.
    const rlShares = wikiService.getPageShare(serviceId, String(wikiId));
    if (Object.keys(rlShares).length > 0) {
      const callerKey = (c.req.header("x-tdai-user-key") || "").trim();
      const wa = await coreMeta<{ owner_user_id?: string }>("asset/get", { asset_id: wikiId }, callerKey, serviceId);
      const who = callerKey
        ? await coreMeta<{ user?: { user_id?: string } }>("auth/verify", { user_key: callerKey }, callerKey, serviceId)
        : null;
      const wo = wa.data?.owner_user_id;
      if (!wo || who?.data?.user?.user_id !== wo) {
        return c.json(wrapError(403, "permission denied: this wiki has per-page restrictions; raw listing is owner-only"), 403);
      }
    }

    const items = wikiService.rawLs(serviceId, row.team_id, wikiId);
    if (items === null) return c.json(wrapError(404, "wiki not found"), 404);
    return c.json(wrapOk({ items }));
  });

  app.post("/raw/read", async (c) => {
    const body = await c.req.json<Record<string, unknown>>();
    const serviceId = c.req.header("x-tdai-service-id");
    if (!isValidIdSegment(serviceId)) return c.json(wrapError(400, "x-tdai-service-id header is required"), 400);
    const filenames = body.filenames;
    if (!Array.isArray(filenames) || filenames.length === 0) {
      return c.json(wrapError(400, "filenames is required (non-empty array)"), 400);
    }
    if (!filenames.every((s): s is string => typeof s === "string")) {
      return c.json(wrapError(400, "filenames must be string[]"), 400);
    }

    const wikiId = body.wiki_id;
    if (!isValidIdSegment(wikiId)) return c.json(wrapError(400, "wiki_id is required"), 400);

    const denied = await enforceReadAcl(c, String(wikiId));
    if (denied) return denied;

    const row = wikiService.getById(serviceId, wikiId);
    if (!row) return c.json(wrapError(404, "wiki not found"), 404);

    // Per-page ACL (Pillar-4): raw source files can contain a restricted page's content. Until a
    // source→page mapping exists, once ANY page in this wiki has an override, raw source access is
    // owner-only (fail-closed, council #8). No override → unchanged behaviour.
    const rawShares = wikiService.getPageShare(serviceId, String(wikiId));
    if (Object.keys(rawShares).length > 0) {
      const callerKey = (c.req.header("x-tdai-user-key") || "").trim();
      const wa = await coreMeta<{ owner_user_id?: string }>("asset/get", { asset_id: wikiId }, callerKey, serviceId);
      const who = callerKey
        ? await coreMeta<{ user?: { user_id?: string } }>("auth/verify", { user_key: callerKey }, callerKey, serviceId)
        : null;
      const callerId = who?.data?.user?.user_id;
      const wo = wa.data?.owner_user_id;
      if (!wo || callerId !== wo) {
        return c.json(
          wrapError(403, "permission denied: this wiki has per-page restrictions; raw source access is owner-only"),
          403,
        );
      }
    }

    try {
      const result = wikiService.rawReadMany(serviceId, row.team_id, wikiId, filenames);
      const err = maybeWriteError(result);
      if (err) return err;
      return c.json(wrapOk({ items: result }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json(wrapError(400, msg), 400);
    }
  });

  // ── WITH-IdFields ──

  app.post("/raw/write", async (c) => {
    const body = await c.req.json<Record<string, unknown>>();
    const ids = extractIdFields(c.req.header("x-tdai-service-id"), body);
    if (!ids) return c.json(wrapError(400, "x-tdai-service-id header and team_id are required"), 400);

    const wikiId = body.wiki_id;
    const files = body.files;
    if (!isValidIdSegment(wikiId)) return c.json(wrapError(400, "wiki_id is required"), 400);
    if (!Array.isArray(files) || files.length === 0) {
      return c.json(wrapError(400, "files is required (non-empty array)"), 400);
    }

    // 上传大小限制（防御纵深，Panel 侧已有同样校验）
    const MAX_FILE_SIZE = 512 * 1024;
    const MAX_FILES = 10;
    const MAX_TOTAL = 5 * 1024 * 1024;
    if (files.length > MAX_FILES) {
      return c.json(wrapError(413, `too many files (max ${MAX_FILES})`), 413);
    }
    let totalSize = 0;

    const validated: { filename: string; content: string }[] = [];
    for (const item of files) {
      if (!item || typeof item !== "object") {
        return c.json(wrapError(400, "files items must be {filename, content}"), 400);
      }
      const r = item as Record<string, unknown>;
      if (typeof r.filename !== "string" || !r.filename) {
        return c.json(wrapError(400, "filename is required for each file"), 400);
      }
      if (typeof r.content !== "string") {
        return c.json(wrapError(400, "content must be string for each file"), 400);
      }
      const size = Buffer.byteLength(r.content, "utf-8");
      if (size > MAX_FILE_SIZE) {
        return c.json(wrapError(413, `file too large: ${r.filename} (max ${MAX_FILE_SIZE} bytes)`), 413);
      }
      totalSize += size;
      validated.push({ filename: r.filename, content: r.content });
    }
    if (totalSize > MAX_TOTAL) {
      return c.json(wrapError(413, `total too large (max ${MAX_TOTAL} bytes)`), 413);
    }

    try {
      const result = wikiService.rawWriteMany(ids.service_id, ids.team_id, wikiId, validated, ids.user_id);
      const err = maybeWriteError(result);
      if (err) return err;
      return c.json(wrapOk({ items: result }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json(wrapError(400, msg), 400);
    }
  });

  app.post("/raw/rm", async (c) => {
    const body = await c.req.json<Record<string, unknown>>();
    const ids = extractIdFields(c.req.header("x-tdai-service-id"), body);
    if (!ids) return c.json(wrapError(400, "x-tdai-service-id header and team_id are required"), 400);

    const wikiId = body.wiki_id;
    const filenames = body.filenames;
    if (!isValidIdSegment(wikiId)) return c.json(wrapError(400, "wiki_id is required"), 400);
    if (!Array.isArray(filenames) || filenames.length === 0) {
      return c.json(wrapError(400, "filenames is required (non-empty array)"), 400);
    }
    if (!filenames.every((s): s is string => typeof s === "string")) {
      return c.json(wrapError(400, "filenames must be string[]"), 400);
    }

    try {
      const result = await wikiService.rawRm(ids.service_id, ids.team_id, wikiId, filenames);
      const err = maybeWriteError(result);
      if (err) return err;
      try { wikiMgr.sync(wikiId); } catch (e) { console.warn(`[wiki] wikiMgr.sync(${wikiId}) failed after raw/rm:`, e); }
      return c.json(wrapOk(result));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json(wrapError(400, msg), 400);
    }
  });

  // ═══════════════════ File Layer page/* ═══════════════════

  // ── id-only ──

  app.post("/page/ls", async (c) => {
    const body = await c.req.json<Record<string, unknown>>();
    const serviceId = c.req.header("x-tdai-service-id");
    if (!isValidIdSegment(serviceId)) return c.json(wrapError(400, "x-tdai-service-id header is required"), 400);
    const wikiId = body.wiki_id;
    if (!isValidIdSegment(wikiId)) return c.json(wrapError(400, "wiki_id is required"), 400);

    const lsDenied = await enforceReadAcl(c, String(wikiId));
    if (lsDenied) return lsDenied;

    const row = wikiService.getById(serviceId, wikiId);
    if (!row) return c.json(wrapError(404, "wiki not found"), 404);

    const items = wikiService.pageLs(serviceId, row.team_id, wikiId);
    if (items === null) return c.json(wrapError(404, "wiki not found"), 404);
    // Per-page ACL (Pillar-4): omit pages the caller can't read — page/ls would otherwise leak a
    // hidden page's title/path/existence (council #3 fix). item.id is the idFromPath page-id.
    const lsShares = wikiService.getPageShare(serviceId, String(wikiId));
    const lsDeny = new Set<string>();
    for (const [pageId, entry] of Object.entries(lsShares)) {
      if (!(await isReadAllowed(c, pageAssetId(entry.uuid)))) lsDeny.add(pageId);
    }
    const lsItems = lsDeny.size > 0 ? items.filter((it) => !lsDeny.has(it.id)) : items;
    return c.json(wrapOk({ items: lsItems }));
  });

  app.post("/page/read", async (c) => {
    const body = await c.req.json<Record<string, unknown>>();
    const serviceId = c.req.header("x-tdai-service-id");
    if (!isValidIdSegment(serviceId)) return c.json(wrapError(400, "x-tdai-service-id header is required"), 400);
    const refs = body.refs;
    if (!Array.isArray(refs) || refs.length === 0) {
      return c.json(wrapError(400, "refs is required (non-empty array)"), 400);
    }
    if (!refs.every((s): s is string => typeof s === "string")) {
      return c.json(wrapError(400, "refs must be string[]"), 400);
    }

    const wikiId = body.wiki_id;
    if (!isValidIdSegment(wikiId)) return c.json(wrapError(400, "wiki_id is required"), 400);

    const denied = await enforceReadAcl(c, String(wikiId));
    if (denied) return denied;

    const row = wikiService.getById(serviceId, wikiId);
    if (!row) return c.json(wrapError(404, "wiki not found"), 404);

    // Per-page ACL (Pillar-4): drop refs the caller can't read (overridden + denied). A hidden page
    // is simply omitted from the response — indistinguishable from missing, i.e. fail-closed.
    const shares = wikiService.getPageShare(serviceId, String(wikiId));
    const allowedRefs: string[] = [];
    for (const r of refs as string[]) {
      const entry = shares[idFromPath(r)];
      if (entry && !(await isReadAllowed(c, pageAssetId(entry.uuid)))) continue;
      allowedRefs.push(r);
    }

    try {
      const result = wikiService.pageReadMany(serviceId, row.team_id, wikiId, allowedRefs);
      const err = maybeWriteError(result);
      if (err) return err;
      return c.json(wrapOk({ items: result }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json(wrapError(400, msg), 400);
    }
  });

  // ── WITH-IdFields ──

  app.post("/page/write", async (c) => {
    const body = await c.req.json<Record<string, unknown>>();
    const ids = extractIdFields(c.req.header("x-tdai-service-id"), body);
    if (!ids) return c.json(wrapError(400, "x-tdai-service-id header and team_id are required"), 400);

    const wikiId = body.wiki_id;
    const pages = body.pages;
    if (!isValidIdSegment(wikiId)) return c.json(wrapError(400, "wiki_id is required"), 400);
    if (!Array.isArray(pages) || pages.length === 0) {
      return c.json(wrapError(400, "pages is required (non-empty array)"), 400);
    }

    const validated: { ref: string; content: string }[] = [];
    for (const item of pages) {
      if (!item || typeof item !== "object") {
        return c.json(wrapError(400, "pages items must be {ref, content}"), 400);
      }
      const r = item as Record<string, unknown>;
      if (typeof r.ref !== "string" || !r.ref) {
        return c.json(wrapError(400, "ref is required for each page"), 400);
      }
      if (typeof r.content !== "string") {
        return c.json(wrapError(400, "content must be string for each page"), 400);
      }
      validated.push({ ref: r.ref, content: r.content });
    }

    try {
      const result = wikiService.pageWriteMany(ids.service_id, ids.team_id, wikiId, validated);
      const err = maybeWriteError(result);
      if (err) return err;
      try { wikiMgr.sync(wikiId); } catch (e) { console.warn(`[wiki] wikiMgr.sync(${wikiId}) failed after page/write:`, e); }
      return c.json(wrapOk({ items: result }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json(wrapError(400, msg), 400);
    }
  });

  app.post("/page/rm", async (c) => {
    const body = await c.req.json<Record<string, unknown>>();
    const ids = extractIdFields(c.req.header("x-tdai-service-id"), body);
    if (!ids) return c.json(wrapError(400, "x-tdai-service-id header and team_id are required"), 400);

    const wikiId = body.wiki_id;
    const refs = body.refs;
    if (!isValidIdSegment(wikiId)) return c.json(wrapError(400, "wiki_id is required"), 400);
    if (!Array.isArray(refs) || refs.length === 0) {
      return c.json(wrapError(400, "refs is required (non-empty array)"), 400);
    }
    if (!refs.every((s): s is string => typeof s === "string")) {
      return c.json(wrapError(400, "refs must be string[]"), 400);
    }

    try {
      const result = await wikiService.pageRm(ids.service_id, ids.team_id, wikiId, refs);
      const err = maybeWriteError(result);
      if (err) return err;
      try { wikiMgr.sync(wikiId); } catch (e) { console.warn(`[wiki] wikiMgr.sync(${wikiId}) failed after page/rm:`, e); }
      // Per-page ACL lifecycle (council #7): a removed page must not orphan its page-asset. For each
      // removed ref that HAD an override, clear the hub mapping + delete the wpage asset (best-effort).
      const rmShares = wikiService.getPageShare(ids.service_id, String(wikiId));
      const rmCallerKey = (c.req.header("x-tdai-user-key") || "").trim();
      for (const r of refs as string[]) {
        const pid = idFromPath(r);
        const entry = rmShares[pid];
        if (!entry) continue;
        wikiService.setPageShare(ids.service_id, String(wikiId), pid, null);
        if (rmCallerKey) await coreMeta("asset/delete", { asset_ids: [pageAssetId(entry.uuid)] }, rmCallerKey, ids.service_id);
      }
      return c.json(wrapOk(result));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json(wrapError(400, msg), 400);
    }
  });

  // ═══════════════════ Derived Views (id-only) ═══════════════════

  app.post("/graph", async (c) => {
    const body = await c.req.json<Record<string, unknown>>();
    const serviceId = c.req.header("x-tdai-service-id");
    if (!isValidIdSegment(serviceId)) return c.json(wrapError(400, "x-tdai-service-id header is required"), 400);
    const wikiId = body.wiki_id;
    if (!isValidIdSegment(wikiId)) return c.json(wrapError(400, "wiki_id is required"), 400);

    // Wiki-level read gate (council #1 fix): the graph exposes every node title/path + edges, so it
    // must be gated like page/read + search (it previously wasn't).
    const gdenied = await enforceReadAcl(c, String(wikiId));
    if (gdenied) return gdenied;

    const row = wikiService.getById(serviceId, wikiId);
    if (!row) return c.json(wrapError(404, "wiki not found"), 404);

    if (row.status !== "ready") {
      return c.json(wrapOk({ nodes: [], edges: [], communities: [] }));
    }
    const graphData = wikiMgr.graph(wikiId);
    // Per-page ACL (Pillar-4): scrub nodes + edges for pages the caller can't read (council #8) —
    // node.id and edge.source/target are all page-ids (idFromPath form), so excludeIds matches directly.
    const gExclude = new Set<string>();
    const gShares = wikiService.getPageShare(serviceId, String(wikiId));
    for (const [pageId, entry] of Object.entries(gShares)) {
      if (!(await isReadAllowed(c, pageAssetId(entry.uuid)))) gExclude.add(pageId);
    }
    if (gExclude.size > 0) {
      graphData.nodes = graphData.nodes.filter((n) => !gExclude.has(n.id));
      graphData.edges = graphData.edges.filter((e) => !gExclude.has(e.source) && !gExclude.has(e.target));
    }
    return c.json(wrapOk(graphData));
  });

  app.post("/search", async (c) => {
    const body = await c.req.json<Record<string, unknown>>();
    const serviceId = c.req.header("x-tdai-service-id");
    if (!isValidIdSegment(serviceId)) return c.json(wrapError(400, "x-tdai-service-id header is required"), 400);
    const query = body.query;
    if (typeof query !== "string" || !query) return c.json(wrapError(400, "query is required"), 400);

    const wikiId = body.wiki_id;
    if (!isValidIdSegment(wikiId)) return c.json(wrapError(400, "wiki_id is required"), 400);

    const denied = await enforceReadAcl(c, String(wikiId));
    if (denied) return denied;

    const row = wikiService.getById(serviceId, wikiId);
    if (!row) return c.json(wrapError(404, "wiki not found"), 404);

    if (row.status !== "ready") {
      return c.json(wrapOk({ results: [], links: [], count: 0 }));
    }

    const limit = typeof body.limit === "number" ? body.limit : 20;

    // Optional graph-expansion params (PRD §4.1).
    let hop: number | undefined;
    if (body.hop !== undefined) {
      if (typeof body.hop !== "number" || !Number.isInteger(body.hop) || body.hop < 0 || body.hop > 5) {
        return c.json(wrapError(400, "hop must be an integer in 0..5"), 400);
      }
      hop = body.hop;
    }

    let decay: number | undefined;
    if (body.decay !== undefined) {
      if (typeof body.decay !== "number" || body.decay < 0 || body.decay > 1 || Number.isNaN(body.decay)) {
        return c.json(wrapError(400, "decay must be a number in 0..1"), 400);
      }
      decay = body.decay;
    }

    let minScore: number | undefined;
    if (body.minScore !== undefined) {
      if (typeof body.minScore !== "number" || body.minScore < 0 || Number.isNaN(body.minScore)) {
        return c.json(wrapError(400, "minScore must be a non-negative number"), 400);
      }
      minScore = body.minScore;
    }

    // Per-page ACL (Pillar-4): hide pages the caller can't read. Only OVERRIDDEN pages need a check
    // (all others are covered by the wiki-level gate above); the hub knows which from its local map,
    // so this costs one acl/check per shared page, not per hit. The exclude-set is applied INSIDE the
    // search engine so hidden pages never leak via related/links/count (council #3/#6).
    const excludeIds = new Set<string>();
    const shares = wikiService.getPageShare(serviceId, String(wikiId));
    for (const [pageId, entry] of Object.entries(shares)) {
      if (!(await isReadAllowed(c, pageAssetId(entry.uuid)))) excludeIds.add(pageId);
    }

    const response = wikiMgr.search(wikiId, query, limit, { hop, decay, minScore, excludeIds });
    return c.json(wrapOk(response));
  });

  return app;
}
