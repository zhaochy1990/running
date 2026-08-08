# Go team API keeps identity in auth-service and activity data in MySQL

The team web surface is migrated from Python to Go without moving team identity into STRIDE storage. Go now implements the team, membership-backed feed and mileage, teammate activity detail, and team activity likes endpoints. `POST /api/teams/{team_id}/sync-all` remains Python-owned.

## Decision

### Ownership boundaries

- The in-house auth-service remains the source of truth for teams, ownership, and memberships. Go does not create team or membership tables.
- Every Go team request keeps the caller's original `Authorization` header and forwards it unchanged to auth-service for team and membership operations. The Go API therefore depends on auth-service availability and a configured `api.auth-service-url`; local JWT verification alone is not a replacement for membership authorization.
- STRIDE MySQL remains canonical for watch-synced activities and user-profile enrichment. Team feed, mileage, and teammate activity detail read those existing MySQL records for the member IDs returned by auth-service.
- Go API persistent state, including team activity likes, is canonical in MySQL. The `team_likes` key `(team_id, owner_user_id, label_id, liker_user_id)` makes writes idempotent and prevents likes leaking across teams.
- No team or social state is written to per-user SQLite. Python services retain their existing Azure Table backends; Go API features do not add Azure storage dependencies.

### Likes migration and notifications

Existing Python/Azure likes history is intentionally discarded. `team_likes` starts empty: there is no Azure backfill, no migration job, and no dual write between Azure and MySQL. Rolling the routes back to Python can therefore expose the separate legacy Azure view rather than the likes written after Go cutover.

This phase does not send push notifications for likes. Adding like notifications requires a separate ownership and delivery decision; the Go mutation only updates `team_likes` and returns the resulting count/state.

### Strangler cutover

The BFF marks 15 migrated method/path entries Go-ready: `GET /api/users/me/teams` plus 14 direct team endpoints. `POST /api/teams/{team_id}/sync-all` is deliberately not Go-ready and keeps routing to Python because its multi-member sync orchestration was not migrated.

Each route still has its own `STRIDE_ROUTE_*` flag for targeted verification. Operationally, team feed and the three likes methods form one cutover and rollback unit:

```text
GET    /api/teams/{team_id}/feed
GET    /api/teams/{team_id}/activities/{user_id}/{label_id}/likes
POST   /api/teams/{team_id}/activities/{user_id}/{label_id}/likes
DELETE /api/teams/{team_id}/activities/{user_id}/{label_id}/likes
```

Feed reads `team_likes` for `like_count`, `you_liked`, and `top_likers`; splitting its upstream from the likes mutations produces inconsistent social state. Set all four flags to `go` together, and remove or reset all four together when rolling back. Because Azure history is not migrated and writes are not duplicated, rollback is a routing safety action, not lossless data reconciliation.

### Schema startup

`stride api` calls the dedicated `AutoMigrateTeamLikes` startup migration after the existing core/user/plan migrations. It creates or reconciles only `team_likes`; it does not create auth-service-owned team or membership tables. A schema migration failure prevents the Go API from starting rather than serving a partial team surface.

## Consequences

- Team authorization remains centralized in auth-service while activity-heavy reads stay close to canonical MySQL data.
- Go team routes require both MySQL and auth-service; auth-service failures may make membership-dependent requests unavailable.
- Likes begin from an intentionally empty canonical dataset, and Python/Go likes must not be expected to agree during rollback.
- Feed and likes retain per-endpoint switches for testing, but production operation treats them atomically.
- Team-wide sync remains on Python until its orchestration receives a separate migration decision.
