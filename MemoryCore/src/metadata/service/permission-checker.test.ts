/**
 * Focused test slice for the P1 (expiry) + P2 ('team' subject) sharing-enforcement increment.
 *
 * Scope note: this covers the council-authorized P1+P2 changes and the regression cases the council
 * required (in-team admin rw, member read, restricted ACL, private-non-owner). The P3 step-3 rework,
 * P3.5 deny-wins, and P4 includeCode split are HELD pending council review of the P3 sketch, so their
 * cases are intentionally NOT here yet.
 */
import { describe, it, expect } from "vitest";
import { checkPermission } from "./permission-checker.js";
import type { AssetEntity, TeamMemberEntity, AclEntity, Permission } from "../types.js";

const TEAM = "team-1";
const OWNER = "usr-owner";
const OTHER = "usr-other";

function asset(over: Partial<AssetEntity> = {}): AssetEntity {
  return {
    // only the fields the checker reads matter; cast keeps the fixture small
    asset_id: "ast-1",
    team_id: TEAM,
    owner_user_id: OWNER,
    visibility: "team",
    status: "active",
    ...over,
  } as AssetEntity;
}

function member(role: TeamMemberEntity["role"], over: Partial<TeamMemberEntity> = {}): TeamMemberEntity {
  return { team_id: TEAM, user_id: OTHER, role, status: "active", ...over } as TeamMemberEntity;
}

function acl(over: Partial<AclEntity>): AclEntity {
  return {
    id: "acl-1",
    asset_id: "ast-1",
    subject_type: "user",
    subject_id: OTHER,
    permission: "read",
    effect: "allow",
    granted_by: OWNER,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

const NOW = "2026-08-12T12:00:00.000Z";
const PAST = "2026-08-01T00:00:00.000Z";
const FUTURE = "2026-12-31T00:00:00.000Z";

function check(
  action: Permission,
  a: AssetEntity,
  m: TeamMemberEntity | null,
  aclRecords: AclEntity[] = [],
  extra: { now?: string; callerTeamIds?: string[]; agentId?: string } = {},
) {
  return checkPermission({
    user: { user_id: OTHER },
    asset: a,
    membership: m,
    action,
    aclRecords,
    now: NOW,
    ...extra,
  });
}

describe("checkPermission — regression (must be unchanged)", () => {
  it("owner always allowed, before any grant", () => {
    expect(checkPermission({ user: { user_id: OWNER }, asset: asset({ visibility: "private" }), membership: null, action: "write", aclRecords: [], now: NOW }).allowed).toBe(true);
  });
  it("team admin can write; member can read; member cannot write", () => {
    expect(check("write", asset(), member("admin")).allowed).toBe(true);
    expect(check("read", asset(), member("member")).allowed).toBe(true);
    expect(check("write", asset(), member("member")).allowed).toBe(false);
  });
  it("private asset denies a non-owner team member", () => {
    expect(check("read", asset({ visibility: "private" }), member("member")).allowed).toBe(false);
  });
  it("restricted asset: non-admin allowed only via explicit user ACL", () => {
    expect(check("read", asset({ visibility: "restricted" }), member("member")).allowed).toBe(false);
    expect(check("read", asset({ visibility: "restricted" }), member("member"), [acl({})]).allowed).toBe(true);
  });
  it("non-team-member is denied (P3 hard-deny still in place)", () => {
    expect(check("read", asset(), null, [acl({})]).allowed).toBe(false);
  });
});

describe("P1 — expiry", () => {
  it("a non-expired grant still matches", () => {
    expect(check("read", asset({ visibility: "restricted" }), member("member"), [acl({ expires_at: FUTURE })]).allowed).toBe(true);
  });
  it("an expired grant no longer matches", () => {
    expect(check("read", asset({ visibility: "restricted" }), member("member"), [acl({ expires_at: PAST })]).allowed).toBe(false);
  });
  it("a null expiry never expires (existing grants unaffected)", () => {
    expect(check("read", asset({ visibility: "restricted" }), member("member"), [acl({ expires_at: null })]).allowed).toBe(true);
  });
});

describe("P2 — 'team' subject", () => {
  it("member of a granted team is allowed", () => {
    const grant = acl({ subject_type: "team", subject_id: "team-shared" });
    expect(check("read", asset({ visibility: "restricted" }), member("member"), [grant], { callerTeamIds: ["team-shared"] }).allowed).toBe(true);
  });
  it("non-member of the granted team is denied", () => {
    const grant = acl({ subject_type: "team", subject_id: "team-shared" });
    expect(check("read", asset({ visibility: "restricted" }), member("member"), [grant], { callerTeamIds: ["team-other"] }).allowed).toBe(false);
  });
  it("a 'team' grant respects expiry too", () => {
    const grant = acl({ subject_type: "team", subject_id: "team-shared", expires_at: PAST });
    expect(check("read", asset({ visibility: "restricted" }), member("member"), [grant], { callerTeamIds: ["team-shared"] }).allowed).toBe(false);
  });
});
