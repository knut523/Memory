import { describe, it, expect, vi } from "vitest";

process.env.MEMORY_CORE_URL = "http://mc";
process.env.MEMORY_CORE_KEY = "k";
const { isReadAllowed } = await import("./read-acl.js");

function ctx(userKey = "u1") {
  return {
    req: { header: (n: string) => (n === "x-tdai-user-key" ? userKey : n === "x-tdai-service-id" ? "default" : "") },
    json: (body: any, status: number) => ({ __status: status, body }),
  } as any;
}
function mockCheck(verdict: { allowed: boolean; reason: string }) {
  global.fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ code: 0, data: verdict }) })) as any;
}

describe("isReadAllowed (Pillar-4 per-page filter primitive)", () => {
  it("allowed verdict → true (owner/permitted keeps the page)", async () => {
    mockCheck({ allowed: true, reason: "owner" });
    expect(await isReadAllowed(ctx(), "wpage_x")).toBe(true);
  });

  it("denied verdict → false (page is dropped)", async () => {
    mockCheck({ allowed: false, reason: "visibility_restricted" });
    expect(await isReadAllowed(ctx(), "wpage_x")).toBe(false);
  });

  it("no user key → false (fail-closed)", async () => {
    mockCheck({ allowed: true, reason: "owner" });
    expect(await isReadAllowed(ctx(""), "wpage_x")).toBe(false);
  });

  it("core unreachable / throw → false (fail-closed)", async () => {
    global.fetch = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as any;
    expect(await isReadAllowed(ctx(), "wpage_x")).toBe(false);
  });
});
