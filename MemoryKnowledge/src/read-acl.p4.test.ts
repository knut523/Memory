import { describe, it, expect, vi } from "vitest";

process.env.MEMORY_CORE_URL = "http://mc";
process.env.MEMORY_CORE_KEY = "k";
const { enforceReadAcl } = await import("./read-acl.js");

// Minimal Hono-ish context: header() + json() (json returns a marker so we can assert the 403).
function ctx(userKey = "u1") {
  return {
    req: { header: (n: string) => (n === "x-tdai-user-key" ? userKey : n === "x-tdai-service-id" ? "default" : "") },
    json: (body: any, status: number) => ({ __status: status, body }),
  } as any;
}
// Mock memory-core /v3/meta/acl/check. The verdict may depend on the requested `action` so we can
// prove that even an asset the caller IS allowed 'use' on is STILL denied full source (owner-only
// tier) — the P4 fix must not overload 'use' as a source-tier proxy (council STOP, 2026-08-13).
function mockCheck(policy: (action: string) => { allowed: boolean; reason: string }) {
  global.fetch = vi.fn(async (_url: any, init: any) => {
    const action = JSON.parse(init.body).action as string;
    const r = policy(action);
    return { ok: true, status: 200, json: async () => ({ code: 0, data: r }) } as any;
  }) as any;
}

describe("P4 includeCode source-tier gate (Hole B) — owner-only", () => {
  it("owner → full source", async () => {
    mockCheck(() => ({ allowed: true, reason: "owner" }));
    expect(await enforceReadAcl(ctx(), "a1", { requireOwner: true })).toBeNull();
  });

  it("plain read / team-read grant → full source DENIED (leak closed), symbols still allowed", async () => {
    mockCheck(() => ({ allowed: true, reason: "acl:x" }));
    const full = (await enforceReadAcl(ctx(), "a1", { requireOwner: true })) as any;
    expect(full).not.toBeNull();
    expect(full.__status).toBe(403);
    const symbols = await enforceReadAcl(ctx(), "a1", { requireOwner: false });
    expect(symbols).toBeNull();
  });

  it("non-owner grant that ALSO allows 'use' → full source STILL DENIED (owner-only; 'use' is not a source-tier proxy)", async () => {
    // allowed for read AND use, but reason is a plain acl grant, not owner
    mockCheck(() => ({ allowed: true, reason: "acl:y" }));
    const full = (await enforceReadAcl(ctx(), "a1", { requireOwner: true })) as any;
    expect(full).not.toBeNull();
    expect(full.__status).toBe(403);
  });

  it("no access at all → 403", async () => {
    mockCheck(() => ({ allowed: false, reason: "not_team_member" }));
    const r = (await enforceReadAcl(ctx(), "a1", { requireOwner: false })) as any;
    expect(r.__status).toBe(403);
  });
});
