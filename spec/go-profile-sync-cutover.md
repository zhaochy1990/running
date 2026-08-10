# Go profile and sync cutover specification

## Goal

Move Web profile editing, user-declared running background, injury records, and training-plan setup synchronization onto Go-owned APIs. Remove Web dependencies on Python `running-profile`, `full-sync`, and `full-sync-status` without adding compatibility code for the old UI.

## Scope

### Go profile

- Add `running_age_range` to `user_profile` with values `unknown`, `lt_6m`, `6m_1y`, `1y_3y`, `3y_plus`.
- `GET /api/users/me/profile` always returns it.
- `POST /api/users/me/profile` requires it; missing or invalid values return 422.
- `PATCH /api/users/me/profile` accepts the existing five core fields plus `running_age_range` and updates only an existing profile. Missing profiles remain 404. A user may set the value back to `unknown`.
- Mark the BFF PATCH route Go-ready and route it to Go in production after the Go capability is deployed.
- The personal settings profile request must contain only display name, date of birth, sex, height, weight, and running age. Remove race, PB, weekly-mileage, and constraints fields from this page rather than sending them to profile PATCH.

### Injury records

- Persist injury records in MySQL under the authenticated JWT subject.
- Record shape:

```json
{
  "id": "server-generated-id",
  "description": "1-1000 trimmed characters",
  "recovery_status": "active | recovered",
  "running_restriction": "none | easy_only | no_running",
  "created_at": "UTC timestamp",
  "updated_at": "UTC timestamp"
}
```

- Enforce `recovered + none` and `active + (easy_only | no_running)`.
- Implement:
  - `GET /api/users/me/injuries?limit=50&cursor=...`
  - `POST /api/users/me/injuries`
  - `PUT /api/users/me/injuries/{injuryId}`
  - `DELETE /api/users/me/injuries/{injuryId}`
- GET uses an opaque cursor, defaults to 50, accepts `limit` from 1 through 50, and returns active records first, then `updated_at` descending, then ID.
- GET returns `{ "items": InjuryRecord[], "next_cursor": string | null }`. ID is descending as the final tie-breaker; `next_cursor=null` marks the last page.
- PUT requires all three editable fields. DELETE is physical, returns 204, and returns 404 for missing or foreign records.
- Personal settings presents profile/running age and injuries as separate save areas. Injury mutations reload the first list page.

### Onboarding

- Add a required running-age selector to profile onboarding; `unknown` is an explicit valid choice.
- Add a skippable injury-management step using the same injury CRUD APIs. Mutations save immediately. Empty and skipped are equivalent.
- Onboarding finalization requires a valid profile including running age, but does not require an injury record.
- Replace `web-onboarding-v1` with `web-onboarding-v2`. Its exact capability set contains the existing seven onboarding routes plus `PATCH /api/users/me/profile`, `GET/POST /api/users/me/injuries`, and `PUT/DELETE /api/users/me/injuries/:injuryId`. Update the Go capability response/test, deploy-workflow exact-set assertion, BFF atomic-cutover validation, production route flags, and deployment documentation together.
- Add a separate `plan-setup-v1` readiness capability that attests to `GET/POST /api/users/me/training-goal`, `POST /api/:user/sync`, `GET /api/pipelines/:run_id`, and the deployed canonical MySQL season-plan context reader contract. Web deployment must verify this capability through both the Go origin and direct gateway before enabling the plan-setup route flags.

### Training-plan setup sync

- Remove the running age, weekly mileage, PB, and injury form from `TrainingPlanSetup`.
- After saving the race goal, call existing Go `POST /api/{user}/sync` with `{"mode":"incremental"}`.
- Use an in-memory idempotency key for transport retries of one start attempt. A terminal failure, polling timeout, or explicit user retry creates a new key and a new incremental run. A page refresh also creates a new key.
- Poll `GET /api/pipelines/{run_id}` and show one unified loading state; do not poll individual jobs for progress.
- Start season-plan generation only after the Pipeline Run is `done`.
- A failed or timed-out run blocks generation and offers retry. Timeout stops polling; retry may create another incremental run.
- Delete Web wrappers and production call sites for:
  - `POST /api/users/me/running-profile`
  - `POST /api/users/me/full-sync`
  - `GET /api/users/me/full-sync-status`
- Remove their BFF entries once no Web runtime uses them. Keep Python routes temporarily for non-Web compatibility unless separately retired.

### Canonical generation inputs

- Before Web route cutover, migrate the Python season-plan context readers for race goal, activities, health, PBs, calibration, and training load to canonical MySQL through `stride_storage` APIs. Do not query MySQL directly outside `stride_storage` and do not fall back to SQLite when MySQL is unavailable.
- The goal ID returned by the Go race-goal API must resolve through the same canonical reader used by season-plan generation before generation starts.
- Route both `GET` and `POST /api/users/me/training-goal` to Go as part of the same declared plan-setup cutover. A mixed Python writer/Go reader configuration is invalid and must fail BFF startup or deployment validation.
- Expose the canonical reader contract version in `plan-setup-v1` readiness. `deploy-web` must refuse the route-flag update unless the exact route set and reader capability match; source-controlled release order alone is not a sufficient gate.
- New running age and injury records remain out of the generator prompt in this delivery; this is an intentional product-scope limitation, not a storage fallback.

## Data migration

- Provide a one-time command that reads legacy `running_profile.json` content and updates MySQL only when `running_age_range=unknown`.
- Support dry-run and repeat execution. Report migrated, skipped, missing, and failed counts without exposing user content or credentials.
- Do not migrate legacy injury strings. Failures leave running age as `unknown` and do not block cutover.

## Accepted limitations

- The Python season-plan generator does not consume the new MySQL running age or injuries in this delivery. Saving these fields therefore does not yet affect generated-plan personalization.
- Incremental sync does not recompute the 180-day calibration baseline; it synchronizes new data and incrementally computes load, PMC, and PBs.
- Existing completed users are not forced back through onboarding.
- Stale Web clients are unsupported. Deploying the breaking Go profile POST before Web may temporarily make the old onboarding UI fail with 422; this short deployment window is explicitly accepted, but the new Web must not deploy before Go and the canonical MySQL readers.

## Verification

- Go storage and handler tests cover tenant isolation, profile validation, injury state combinations, complete PUT, physical DELETE, pagination ordering/cursors, and 404 behavior.
- BFF tests cover the exact `web-onboarding-v2` and `plan-setup-v1` capability sets, method-specific routing, direct routing, atomic route selection (including both training-goal methods), and production flags.
- Frontend tests cover onboarding selection/skipping, settings CRUD, removal of legacy profile fields, incremental sync success/failure/timeout/retry, and generation only after `done`.
- Run Go tests and vet, frontend/BFF tests and builds, then the required `dev:web:local` + `smoke:web:local` browser smoke. Add a focused browser smoke for profile editing and training-plan setup because the existing smoke does not cover either flow.

## Release order

1. Implement and deploy canonical MySQL season-plan readers, including race goal and synchronized training context, with the `plan-setup-v1` readiness capability.
2. Deploy the Go schema, APIs, `web-onboarding-v2` readiness capability, and migration command.
3. Run and review the running-age migration report.
4. Verify the Tencent gateway supports the new methods, authorization headers, CORS, and OPTIONS requests.
5. Deploy Web UI, BFF manifest, and the complete expected route-flag set together. Audit and remove stale ACA `STRIDE_ROUTE_*` overrides rather than relying on incremental updates. Do not use authenticated or mutating gateway route probes in deploy-web; no harmless endpoint/token exists.
6. As a separate production release-verification step, using valid user credentials, verify profile PATCH, injury CRUD, onboarding, incremental pipeline completion, and generation gating.
