# STRIDE Telemetry — Kusto Query Starter Pack

The frontend ships page-view telemetry to Application Insights (`stride-appi`,
resource group `rg-running-prod`, region `southeastasia`). Every route change
emits one `pageViews` row with:

| Column | Source |
|---|---|
| `name` | `routeNameFor(pathname)` — stable across path-param values (`/activity/:id` → `Activity Detail`) |
| `url` | the raw `pathname` |
| `user_AuthenticatedId` | JWT `sub` (UUID) for logged-in users; empty otherwise |
| `user_Id` | anonymous session id assigned by the SDK |
| `session_Id` | rotates on browser restart |
| `timestamp` | UTC |

To open these queries: Azure Portal → **stride-appi** → **Logs** → paste.

## Top pages by visits, last 7 days

```kql
pageViews
| where timestamp > ago(7d)
| summarize visits=count(), users=dcount(user_AuthenticatedId) by name
| order by visits desc
```

## Distinct active users per day, last 7 days

```kql
pageViews
| where timestamp > ago(7d) and isnotempty(user_AuthenticatedId)
| summarize visits=count() by user_AuthenticatedId, bin(timestamp, 1d)
| render columnchart
```

## Per-user page breakdown, last 30 days

```kql
pageViews
| where timestamp > ago(30d) and isnotempty(user_AuthenticatedId)
| summarize visits=count() by user_AuthenticatedId, name
| order by user_AuthenticatedId asc, visits desc
```

## Average session length per user, last 30 days

```kql
pageViews
| where timestamp > ago(30d) and isnotempty(user_AuthenticatedId)
| summarize sessionStart=min(timestamp), sessionEnd=max(timestamp)
    by user_AuthenticatedId, session_Id
| extend sessionMinutes = (sessionEnd - sessionStart) / 1m
| summarize avgMinutes=avg(sessionMinutes), sessions=count()
    by user_AuthenticatedId
```

## Login → onboarding funnel, last 30 days

```kql
let login = pageViews
    | where timestamp > ago(30d) and name == 'Login'
    | project user_Id, loginAt = timestamp;
let onboarding = pageViews
    | where timestamp > ago(30d) and name == 'Onboarding'
    | project user_Id, onboardingAt = timestamp;
login
| join kind=leftouter onboarding on user_Id
| summarize loginCount=count(),
            onboardingCount=countif(isnotempty(onboardingAt))
| extend conversion = round(100.0 * onboardingCount / loginCount, 1)
```

## Verify parameterized-route collapsing (Plan §5 step 6)

```kql
pageViews
| where timestamp > ago(15m)
| summarize visits=count() by name, url
| order by name asc, url asc
```

After visiting two distinct `/activity/<id>` URLs, the table should show
`name == 'Activity Detail'` for both rows even though `url` differs. Same
for `/week/<folder>` → `Week View`.
