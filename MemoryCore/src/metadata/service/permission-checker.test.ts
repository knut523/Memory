/**
 * Focused test slice for the P1 (expiry) + P2 ('team' subject) sharing-enforcement increment.
 *
 * Covers P1 (expiry), P2 ('team' subject), and P3 (non-member direct-grant step-3 rework, incl. the
 * guard that a non-member can never match team_role / inherit role defaults) plus the regression cases
 * (owner, in-team admin rw / member read, restricted ACL, private-non-owner). P3.5 deny-wins and P4
 * includeCode source-tier split remain HELD (not implemented), so their cases are intentionally absent.
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
  it("non-team-member with NO grant is denied", () => {
    expect(check("read", asset(), null, []).allowed).toBe(false);
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

describe("P3 — non-member direct grants (step-3 rework)", () => {
  const restricted = () => asset({ visibility: "restricted" });
  it("a non-member with a direct user grant is allowed", () => {
    expect(check("read", restricted(), null, [acl({})]).allowed).toBe(true);
  });
  it("a non-member with NO grant is denied (not_team_member)", () => {
    expect(check("read", restricted(), null, []).reason).toBe("not_team_member");
  });
  it("GUARD: a non-member with only a team_role grant is DENIED (role can't apply)", () => {
    const roleGrant = acl({ subject_type: "team_role", subject_id: "member" });
    const r = check("read", restricted(), null, [roleGrant]);
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe("not_team_member");
  });
  it("a non-member's expired grant is denied; a future one allows (P1 applies)", () => {
    expect(check("read", restricted(), null, [acl({ expires_at: PAST })]).allowed).toBe(false);
    expect(check("read", restricted(), null, [acl({ expires_at: FUTURE })]).allowed).toBe(true);
  });
  it("a non-member with a matching 'team' grant is allowed; non-matching denied", () => {
    const g = acl({ subject_type: "team", subject_id: "team-shared" });
    expect(check("read", restricted(), null, [g], { callerTeamIds: ["team-shared"] }).allowed).toBe(true);
    expect(check("read", restricted(), null, [g], { callerTeamIds: ["team-other"] }).allowed).toBe(false);
  });
  it("owner still allowed before the non-member path", () => {
    expect(checkPermission({ user: { user_id: OWNER }, asset: restricted(), membership: null, action: "read", aclRecords: [], now: NOW }).allowed).toBe(true);
  });
});
