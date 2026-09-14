# The Admin Dashboard can generate and apply plans for any athlete

Status: accepted

## Context

ADR 0030 put plan generation behind the Coach: an athlete confirms a 计划提案 in chat and the deterministic coach endpoint enqueues the plan job. That leaves the admin with no way to generate a plan on an athlete's behalf, and no way to inspect or apply the drafts a job produces:

- The plan-job enqueue/poll surface is `/api/users/me/coach/plan-jobs`, keyed to the caller's JWT `sub`. An admin JWT would enqueue for the *admin's own* account.
- The Go draft reads exist (`GET /api/{user}/plan/drafts/{plan_id}`, `GET /api/users/{user_id}/master-plan/drafts/{plan_id}`) but there is no way to *list* a user's drafts, so the dashboard cannot offer them.
- Draft `activate` was mounted on the default-deny group, so an admin JWT got `403` by design.

## Decisions

- **Admin-scoped plan jobs.** The Coach API exposes `POST|GET /api/admin/users/{user_id}/coach/plan-jobs[/{job_id}]`, guarded by `createAdminMiddleware`. The `{user_id}` in the path — never the caller — owns the job. The admin tier is the same rule the Go API uses for `TierAdmin`: the token carries the admin audience **and** `role=admin`; an audience match with any other role is rejected as an unauthenticated caller. Kernel requests are re-validated per job type exactly as on the athlete path.
- **Drafts are readable and appliable by admins.** Two list reads join the existing per-draft reads on the authenticated group: `GET /api/{user}/plan/drafts` and `GET /api/users/{user_id}/master-plan/drafts` (metadata only; content stays on the per-draft read). Draft activation moves to `registerDraftActivates` on the authenticated parent group, so a verified admin or internal caller may apply a draft. Insert stays internal-token-only and abandon stays user-scoped on the default-deny group: the admin can apply what a job generated, but cannot fabricate or discard an athlete's draft.
- **Generation still never auto-activates.** A job only ever inserts a draft (ADR 0030 unchanged). Enabling one is a separate, explicit admin action in the dashboard, and the week's previous active row is archived in the same transaction by the existing storage path.

## Consequences

- The admin dashboard owns the whole loop: create a weekly/season plan job for a chosen user, watch it to a terminal state, review the resulting draft next to the week's active plan, then apply it.
- Draft lifecycle audits in `docs/adr/0025` / `0030` no longer hold for activation; draft *insert* and *abandon* keep the original admin-excluded posture.
- The admin surface is same-origin on `admin.stride-running.cn` and crosses two upstreams (Go for plan + draft routes, the Coach API for plan jobs). Both the local nginx config and the production Caddyfile must carry the explicit matchers, and `tencent/test_caddy_contract.py` asserts them — an unmatched `/api/*` falls through to auth-backend and 404s.
