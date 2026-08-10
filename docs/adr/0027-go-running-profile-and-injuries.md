# Go owns running profile and injury records

The legacy Python `running-profile` combines user-declared running age and injuries with weekly mileage and personal bests that can be derived from watch data. We retire that Web contract: Go/MySQL extends `user_profile` with the declared `running_age_range`, while injury history becomes a separate Go-owned resource with stable record IDs. Weekly mileage and personal bests remain derived watch data and are not copied into either profile resource.

## Decision

- `running_age_range` has five values: `unknown`, `lt_6m`, `6m_1y`, `1y_3y`, and `3y_plus`. Go profile GET/POST/PATCH expose it. Profile POST requires it, including an explicit `unknown`; onboarding and personal settings can update it.
- An injury is an independently mutable record containing `description`, `recovery_status`, and `running_restriction`, plus server-owned ID and timestamps. `recovery_status` is `active|recovered`; `running_restriction` is `none|easy_only|no_running`. `recovered` requires `none`, while `active` requires `easy_only` or `no_running`.
- Go exposes `GET/POST /api/users/me/injuries` and `PUT/DELETE /api/users/me/injuries/{injuryId}`. PUT is a complete replacement of the three editable fields. DELETE physically removes the record and returns 204; missing and cross-user IDs both return 404.
- Injury descriptions are trimmed and contain 1–1000 characters. Creation requires all three editable fields. Listing uses opaque cursor pagination with default and maximum page size 50, ordered by active first, then `updated_at` descending, then ID. Clients reload the first page after mutation because status or update time can move a record.
- Onboarding requires an explicit running-age selection, including `unknown`, and offers full injury management as a skippable step. Injury mutations persist immediately; skipping and an empty list have the same meaning: no recorded injuries. Existing completed users are not blocked when their migrated value remains `unknown`.

## Consequences

- Web stops calling Python `POST /api/users/me/running-profile`. New running age and injuries are canonical in MySQL; the old injury strings are deliberately not migrated.
- A one-time, dry-run-capable migration copies compatible legacy running-age values only into rows still set to `unknown`. It is repeatable, never overwrites a newer explicit value, and reports failures while leaving those users as `unknown`.
- The Python season-plan generator does not consume the new running age or injuries in this delivery. Saving these fields therefore does not yet change generated plans.
- This intentionally breaks the old Web profile POST contract; no compatibility path for stale clients is required. Go may deploy before Web with an explicitly accepted temporary old-UI outage. The unchanged Python season-plan generator is outside this cutover and is not a deployment gate.
