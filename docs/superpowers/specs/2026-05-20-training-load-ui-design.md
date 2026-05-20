# Training Load UI Design

## Goal

Expose STRIDE-computed objective training load in the existing web UI without changing the vendor watch-load semantics. Users should be able to see both the provider PMC/load values and STRIDE's derived dose/ATL/CTL/form values where STRIDE rows exist.

## Scope

This change covers the existing React web dashboard and FastAPI read APIs only. It does not change sync behavior, training-load computation, mobile screens, or existing database schema.

## Data Contract

`GET /api/{user}/pmc` remains backward compatible and continues returning `pmc` and `summary` from `daily_health`. It adds:

- `stride_pmc`: chronological rows from `daily_training_load` in the same requested window.
- `stride_summary`: latest STRIDE row summary with current dose, acute load, chronic load, form, load ratio, readiness gate, readiness reasons, and a 7-day chronic-load ramp.

`GET /api/{user}/activities/{label_id}` and team activity detail responses add:

- `stride_training_load`: `null` when no row exists, otherwise the matching `activity_training_load` row with parsed `reasons` and numeric load fields.

The API does not write `activities.training_load`; that field stays provider/watch load.

## Health Page Design

The Health page keeps the existing vendor PMC section unchanged. When `stride_pmc` has at least one row, the page renders a new STRIDE section below the vendor PMC block.

The STRIDE section uses the existing dense dashboard style: small metric cards plus Recharts charts. Labels intentionally avoid vendor ATI/CTI naming and use STRIDE terms:

- Objective Dose
- Acute Load
- Chronic Load
- Form
- Load Ratio
- Readiness

When no STRIDE rows are returned, the section is hidden silently.

## Activity Detail Design

The current per-activity `训练负荷` metric is renamed to `手表负荷` to clarify that it is the provider value from `activities.training_load`.

When `stride_training_load` exists, a compact STRIDE load panel appears below the secondary metrics inside the activity header card. It shows:

- training dose
- cardio TSS
- external TSS
- mechanical load
- confidence
- included/excluded status and reasons

The panel is hidden when no STRIDE row exists.

## Error And Missing Data Behavior

Missing or malformed JSON reason fields are treated as empty lists. Existing clients that ignore the additive fields continue working.

## Testing

Backend tests verify additive `/pmc` fields and activity detail STRIDE payloads. Frontend tests verify the Health STRIDE section renders only with data and Activity Detail distinguishes watch load from STRIDE load.
