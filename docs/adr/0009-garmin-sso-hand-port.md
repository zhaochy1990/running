# Garmin watch-sync in Go: hand-port garth's SSO (no third-party SDK)

The Garmin adapter (`internal/provider/garmin`) authenticates by **hand-porting
the `garth` SSO flow** in pure `net/http` rather than depending on any Go Garmin
library. Garmin auth is a multi-step OAuth1 → OAuth2 SSO (fetch OAuth1 consumer
creds → SSO login for a service ticket → OAuth1 token → exchange for an OAuth2
bearer → refresh), all behind Cloudflare, on `garmin.cn` vs `garmin.com`. This is
the exact flow the Python stack already proved with `garth` after `garminconnect`'s
built-in login turned out to be broken for CN accounts.

## Decision

- **No external Garmin SDK.** Reimplement garth's `sso.login` / `get_oauth1_token`
  / `exchange` in the adapter, matching the hand-rolled COROS client's house style.
- **OAuth1 consumer key/secret fetched at runtime** from
  `https://thegarth.s3.amazonaws.com/oauth_consumer.json` and cached in-process —
  same as garth, so we track Garmin app-credential rotation without shipping a new
  binary.
- **Cloudflare evasion is load-bearing, not incidental:** send the Android UA
  (`com.garmin.android.apps.connectmobile`) on the OAuth endpoints and browser-like
  `User-Agent` + `Sec-Fetch-*` headers on the SSO endpoints. Dropping these
  reintroduces the CN login failure garth exists to solve.
- **No MFA in v1.** On `MFA_REQUIRED`, login fails fast with a clear error. Login is
  author-run during the shadow phase and the worker only ever resumes stored tokens,
  so the interactive MFA branch is out of scope for now. Write the login path with an
  injectable MFA-code callback so a future two-step server flow drops in later.

## Considered options

- **Depend on a Go library (`abrander/garmin-connect`, `barnes-c/go-garminconnect`,
  …).** Rejected: none advertise `garmin.cn` + Cloudflare support, which is the one
  case that actually matters here and the least likely to be handled; putting an
  unvetted external dependency on the CN credential path is the risk we can least
  afford. Auth is also where we want full control and auditability.
- **Shell out to Python `garth`.** Rejected: defeats the single-binary goal and
  reintroduces a Python runtime dependency into the Go stack.
- **Vendor the OAuth1 consumer key/secret as Go constants.** Rejected as the default:
  if Garmin rotates the app credentials, every login breaks until we rebuild. The
  runtime S3 fetch mirrors garth and self-heals.

## Consequences

- We own Garmin-auth maintenance when Garmin changes their SSO — the cost of not
  taking a library.
- A runtime dependency on `thegarth.s3.amazonaws.com` (a bucket owned by the garth
  author) is now in the login path; a fetch failure blocks fresh logins (but not
  token resume/refresh).
- Garmin credentials reuse the `provider_credentials` store (ADR 0008) with
  `provider='garmin'`; `Secret` holds the full portable OAuth bundle (OAuth1
  token/secret + OAuth2 access/refresh/expiry + domain + UA — the `garth.dumps()`
  equivalent) so token refresh needs no re-login. The `secret` column is widened
  from `varbinary(2048)` to `BLOB`: a real garth dump is ~3.9 KB (base64) and its
  size is controlled by Garmin's JWT, not us, so an opaque off-page `BLOB` avoids
  ever re-guessing a cap.
- The sync write-set targets **full shadow parity** with Python `garmin_sync.run_sync`
  (extends ADR 0005): writes MySQL, nobody reads it, `cmd/reconcile` diffs against
  Python. Garmin-only health signals land in `daily_health` typed columns added to
  complete the ADR 0006 superset (`body_battery_high/low`, `sleep_*`, `sleep_score`,
  `stress_avg`, `respiration_avg`, `spo2_avg`); training-readiness reuses `fatigue`.
