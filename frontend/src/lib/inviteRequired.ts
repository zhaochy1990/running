// Registration invite-code gating, driven by the SAME build-time env var the
// auth backend reads: STRIDE_REQUIRE_INVITE_CODE. Baked at build time via Vite
// envPrefix (see vite.config.ts, Dockerfile.web, .github/workflows/*.yml) —
// there is no runtime injection path in the static SPA.
//
// Semantics mirror the backend:
//   true  → registration requires a valid invite code (Web form shows the
//           required 邀请码 field)
//   false → no invite code needed (field hidden; request omits invite_code)
//
// Defaults to TRUE so the long-standing always-show behavior is preserved
// unless a deployment explicitly opts out (e.g. local dev sets
// STRIDE_REQUIRE_INVITE_CODE=false in frontend/.env.web.local).

export function inviteRequiredFrom(raw: string | undefined): boolean {
  if (raw === undefined || raw === "") return true;
  return raw === "true" || raw === "1";
}

export function inviteRequired(): boolean {
  return inviteRequiredFrom(import.meta.env.STRIDE_REQUIRE_INVITE_CODE);
}
