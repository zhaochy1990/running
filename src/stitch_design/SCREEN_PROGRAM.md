# STRIDE Mobile v1 Stitch Screen Program

This is the execution index for the complete mobile UX design. Product scope comes from `spec/app_feature.md`; Web contributes feature and information-architecture evidence only. Visual direction comes from the current Stitch design system and `prompts/foundation.md`.

## Operating rules

- Work one user story at a time. Generate or edit only the screen currently in progress.
- A meaningful decision, confirmation, recovery, or result state gets a named screen. Minor spacing, color, and copy exploration does not.
- All screens remain in candidate project `12727163079393064568` until the complete program passes global review and the user approves the final review hashes.
- Do not write Flutter, Web, API, or backend code.
- Every adopted screen requires a canonical brief, exported HTML, content review, `390 x 844` and `360 x 800` browser review, and a SHA-256.

## Adopted execution order

The first ten establish the product language. The remaining responsibilities complete the lifecycle in the order previously agreed with the user.

| Order | Spec | Screen responsibility | Route / flow | Canonical brief | Required named states | Status |
|---:|---|---|---|---|---|---|
| 01 | G / D5 | App shell and side drawer | all root tabs | `briefs/app-shell-side-drawer-open.md` | closed home, drawer open, sync running, sync complete, sync failed, logout confirm | in review |
| 02 | D5 | Runner Home | `/v2/home` | `briefs/runner-home-active.md` | active week | candidate adopted |
| 03 | D0 | Training Center | `/v2/train` | `briefs/training-center-active.md` | active season and active week | next |
| 04 | E1 | Data Overview | `/v2/data` | `briefs/data-overview.md` | current data, stale data | pending |
| 05 | H1 | Coach session list | `/v2/coach` | `briefs/coach-session-list.md` | recent sessions, first-use empty | pending |
| 06 | H2-H4 | Coach conversation and proposal | `/v2/coach/:sessionId` | `briefs/coach-conversation-proposal.md` | conversation, proposal review, applying, success, retryable failure, stale conflict, safety refusal | pending |
| 07 | C6 | Active Season Route Map | `/v2/training-plan/view` | `briefs/season-plan-route-map.md` | active season | pending |
| 08 | D2 | Active Weekly Plan | `/v2/plan/weeks/:weekId` | `briefs/weekly-plan-active.md` | active week, historical read-only | pending |
| 09 | D3 | Workout Detail | `/v2/plan/sessions/:sessionId` | `briefs/workout-detail-threshold.md` | pushable structured run, strength, rest or unsupported | pending |
| 10 | D8 | Activity Detail | `/v2/activity/:activityId` | `briefs/activity-detail.md` | complete data, domain-specific missing data | pending |
| 11 | D5 | Runner Home lifecycle | `/v2/home` | `briefs/runner-home-lifecycle.md` | no season, season generating, season review ready, active season/no week, week generating, week review ready, failed, season completed | pending |
| 12 | D0 | Training Center lifecycle | `/v2/train` | `briefs/training-center-lifecycle.md` | no season, season generating, season review ready, active season/no week, week generating, week review ready, failed, season completed | pending |
| 13 | D2 | Week push flow | `/v2/plan/weeks/:weekId` | `briefs/week-watch-push.md` | confirmation, pushing, all success, partial failure, all failure | pending |
| 14 | A0 | Launch and Auth recovery | app launch | `briefs/auth-recovery.md` | restoring, deep-link resume, expired session, network failure | pending |
| 15 | A1 | Identity entry | auth flow | `briefs/auth-entry.md` | default | pending |
| 16 | A2 | Login | auth flow | `briefs/auth-login.md` | default, submitting, credential error, network error | pending |
| 17 | A3 | Registration | auth flow | `briefs/auth-register.md` | default, validation, submitting, invite error | pending |
| 18 | A4 | Forgot password | `/v2/auth/forgot-password` | `briefs/auth-forgot-password.md` | request, generic success, network error | pending |
| 19 | A4 | Reset password | `/v2/auth/reset-password` | `briefs/auth-reset-password.md` | valid token, invalid/expired token, success | pending |
| 20 | B1 | Select watch | onboarding step 1 | `briefs/onboarding-watch-select.md` | COROS available, Garmin coming soon | pending |
| 21 | B2 | Bind COROS | onboarding step 2 | `briefs/onboarding-coros-bind.md` | form, region mismatch, credential error, network error | pending |
| 22 | B3 | First 90-day sync | onboarding step 3 | `briefs/onboarding-first-sync.md` | queued, running, resumed, failed, complete | pending |
| 23 | B4 | Basic athlete information | onboarding step 4 | `briefs/onboarding-athlete-basics.md` | suggested values, edited values, validation | pending |
| 24 | B5 | No-watch blocker | protected-app gate | `briefs/no-watch-blocker.md` | unbound, binding invalid | pending |
| 25 | C1 | Training goal | season creation | `briefs/season-goal.md` | race goal, PB, fat loss, health, maintenance | pending |
| 26 | C2 | Running profile | season creation | `briefs/running-profile.md` | blank optional, prefilled edit | pending |
| 27 | C3 | Three-year history preparation | season creation | `briefs/season-history-sync.md` | running, resumed, insufficient data, failed | pending |
| 28 | C4 | Generate season plan | season creation | `briefs/season-generation.md` | queued, running phases, ready, failed, interrupted | pending |
| 29 | C5 | Review and activate season | season review | `briefs/season-review-activate.md` | initial review, clarification, diff revision, activating | pending |
| 30 | C7 | Adjust season plan | season adjustment | `briefs/season-adjustment.md` | intake, clarification, proposal, impact warning, no change, refusal | pending |
| 31 | C8 | Season adjustment history | season history | `briefs/season-history.md` | timeline | pending |
| 32 | C8 | Season version detail | season history | `briefs/season-version-detail.md` | read-only snapshot | pending |
| 33 | C9 | Season version comparison | `/v2/training-plan/compare/:fromVersion/:toVersion` | `briefs/season-version-compare.md` | changed sections, unchanged collapsed | pending |
| 34 | D1 | Generate weekly plan | week creation | `briefs/week-generation.md` | first week, eligible auto generation, missing-feedback degraded choice, running, failed | pending |
| 35 | D2 | Review weekly draft | `/v2/plan/weeks/:weekId` | `briefs/week-draft-review.md` | review ready, activation confirmation, activating | pending |
| 36 | D4 | Adjust weekly plan | week adjustment | `briefs/week-adjustment.md` | intake, clarification, proposal diff, watch residue warning, applied | pending |
| 37 | D6 | Pre-training | `/v2/plan/sessions/:sessionId/pre` | `briefs/pre-training.md` | ready, watch not pushed, watch pushed | pending |
| 38 | D7 | Post-run feedback | `/v2/activity/:activityId/feedback` | `briefs/post-run-feedback.md` | new, pain selected, submitting, retry, edit existing | pending |
| 39 | D9 | Weekly review | `/v2/review/:weekId` | `briefs/weekly-review.md` | review ready, next-week eligible, missing feedback | pending |
| 40 | D10 | All activities | `/v2/activities` | `briefs/all-activities.md` | populated, empty, loading, error, stale/offline | pending |
| 41 | E2 | Training load | data detail | `briefs/training-load.md` | 30/90/180 days, overload warning, insufficient data | pending |
| 42 | E3 | Health trends | data detail | `briefs/health-trends.md` | metric switching, gaps, unsupported metric | pending |
| 43 | E4 | Ability radar | data detail | `briefs/ability-radar.md` | calibrated, low confidence, missing calibration | pending |
| 44 | E5 | Race predictions | data detail | `briefs/race-predictions.md` | predictions, target gap, history | pending |
| 45 | E6 | PB records | data detail | `briefs/pb-records.md` | populated, distance missing, new PB celebration | pending |
| 46 | F1 | Nutrition preferences | nutrition settings | `briefs/nutrition-preferences.md` | enabled, disabled, recommended macros, custom macros | pending |
| 47 | F2 | Daily nutrition advice | nutrition detail | `briefs/daily-nutrition.md` | training day, rest day, preferences missing | pending |
| 48 | F3 | Meal logging | nutrition log | `briefs/meal-logging.md` | daily log, add/edit food, delete confirm, save failure | pending |
| 49 | G1 | Profile | `/v2/me` | `briefs/profile.md` | populated | pending |
| 50 | G2 | Watch management | `/v2/settings/watch` | `briefs/watch-management.md` | connected, sync failure, unbind confirm, rebind | pending |
| 51 | G3 | Notification rationale | notification onboarding | `briefs/notification-rationale.md` | pre-permission, denied recovery | pending |
| 52 | G3 | Notification settings | `/v2/settings/notifications` | `briefs/notification-settings.md` | permitted, system disabled, registration failure | pending |
| 53 | H5 | Coach memory | `/v2/settings/memories` | `briefs/coach-memory.md` | list, empty, correction, delete confirm | pending |
| 54 | G4 | Support and application info | drawer destinations | `briefs/support-and-app-info.md` | feedback form, FAQ, update states, about | pending |
| 55 | G5 | Account deletion | account security | `briefs/account-deletion.md` | consequence review, typed confirmation, deleting, failure | pending |
| 56 | G5 | Running-club ownership blocker | account deletion | `briefs/team-ownership-blocker.md` | transfer ownership, dissolve team | pending |
| 57 | I1 | Joined running clubs | `/v2/discover` | `briefs/joined-running-clubs.md` | joined list, empty, loading, error | pending |

## Global completion gate

The program is complete only when every row has an adopted Stitch screen set, exported HTML, visual and browser evidence, and final-review SHA-256; cross-screen navigation, terminology, state continuity, safe areas, typography, and the full training loop have also passed one global review.
