import { describe, it, expect } from "vitest";
import { WikiService, pageAssetId } from "./wiki-service.js";
import type { WikiRow } from "./types.js";

function fakeRow(): WikiRow {
  return {
    wiki_id: "wiki-x",
    service_id: "svc",
    team_id: "team-x",
    name: "W",
    owner_user_id: "usr-1",
    status: "ready",
    internal_status: null,
    sync_error: null,
    page_count: 0,
    service_url: null,
    summary: null,
    folder_meta: null,
    page_share: null,
    version: 1,
    last_sync_at: null,
    created_at: "",
    updated_at: "",
    deleted_at: null,
  } as unknown as WikiRow;
}

/** Minimal in-memory store: only the two methods setPageShare/getPageShare touch. */
function svcWithFakeStore(): WikiService {
  let row = fakeRow();
  const store = {
    getWikiById: () => row,
    updateWikiMeta: (_s: string, _w: string, patch: { page_share?: string | null }) => {
      row = { ...row, ...patch };
      return row;
    },
  };
  return new WikiService({ store } as unknown as ConstructorParameters<typeof WikiService>[0]);
}

describe("per-page sharing store (Pillar-4)", () => {
  it("pageAssetId is opaque + a valid id segment", () => {
    expect(pageAssetId("abc123def456")).toBe("wpage_abc123def456");
    expect(/^[A-Za-z0-9_-]+$/.test(pageAssetId("a".repeat(32)))).toBe(true);
  });

  it("mints + persists, reuses the uuid across updates, reads back, and clears", () => {
    const svc = svcWithFakeStore();

    const r1 = svc.setPageShare("svc", "wiki-x", "wiki/notes.md", "private");
    expect(r1).not.toBeNull();
    expect(r1!.uuid).toMatch(/^[a-f0-9]{32}$/);
    expect(r1!.assetId).toBe(`wpage_${r1!.uuid}`);
    expect(svc.getPageShare("svc", "wiki-x")["wiki/notes.md"]).toEqual({ uuid: r1!.uuid, visibility: "private" });

    // same relPath → same stable uuid, visibility updated
    const r2 = svc.setPageShare("svc", "wiki-x", "wiki/notes.md", "team");
    expect(r2!.uuid).toBe(r1!.uuid);
    expect(svc.getPageShare("svc", "wiki-x")["wiki/notes.md"].visibility).toBe("team");

    // a different page gets its own uuid
    const r3 = svc.setPageShare("svc", "wiki-x", "wiki/other.md", "restricted");
    expect(r3!.uuid).not.toBe(r1!.uuid);

    // clear → override removed (page inherits wiki again)
    svc.setPageShare("svc", "wiki-x", "wiki/notes.md", null);
    expect(svc.getPageShare("svc", "wiki-x")["wiki/notes.md"]).toBeUndefined();
    // other page untouched
    expect(svc.getPageShare("svc", "wiki-x")["wiki/other.md"].visibility).toBe("restricted");
  });

  it("returns null when the wiki is missing", () => {
    const store = { getWikiById: () => null, updateWikiMeta: () => null };
    const svc = new WikiService({ store } as unknown as ConstructorParameters<typeof WikiService>[0]);
    expect(svc.setPageShare("svc", "nope", "wiki/x.md", "private")).toBeNull();
  });
});
