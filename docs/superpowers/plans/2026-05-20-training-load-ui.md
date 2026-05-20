# Training Load UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface STRIDE-computed objective training load on the existing Health and Activity Detail web pages while preserving provider watch-load semantics.

**Architecture:** Add backward-compatible read fields to existing FastAPI endpoints. Keep daily STRIDE load sourced from `daily_training_load`, per-activity STRIDE load sourced from `activity_training_load`, and render optional UI sections only when those rows exist.

**Tech Stack:** FastAPI, SQLite, pytest, React 19, TypeScript, Vite, Vitest, React Testing Library, Recharts.

---

## Files

- Modify: `src/stride_server/routes/health.py`
- Modify: `src/stride_server/routes/activities.py`
- Modify: `frontend/src/api.ts`
- Modify: `frontend/src/pages/HealthPage.tsx`
- Modify: `frontend/src/pages/ActivityDetailPage.tsx`
- Test: `tests/stride_server/test_training_load_ui.py`
- Test: `frontend/src/pages/__tests__/HealthPage.test.tsx`
- Test: `frontend/src/pages/__tests__/ActivityDetailPage.test.tsx`

### Task 1: Backend PMC STRIDE Payload

- [ ] Write a pytest route test that seeds `daily_health` and `daily_training_load`, calls `/api/{user}/pmc`, and expects existing `pmc`/`summary` plus additive `stride_pmc`/`stride_summary` fields.
- [ ] Run the new pytest test and verify it fails because `stride_pmc` is missing.
- [ ] Implement JSON parsing and STRIDE daily-row serialization in `src/stride_server/routes/health.py`.
- [ ] Run the targeted pytest test and verify it passes.

### Task 2: Backend Activity STRIDE Payload

- [ ] Write a pytest test that seeds one `activities` row and one `activity_training_load` row, calls `build_activity_detail`, and expects `stride_training_load` with parsed `reasons` and boolean `excluded_from_pmc`.
- [ ] Run the new pytest test and verify it fails because `stride_training_load` is missing.
- [ ] Implement the per-activity serializer in `src/stride_server/routes/activities.py`.
- [ ] Run the targeted pytest test and verify it passes.

### Task 3: Frontend Health STRIDE Section

- [ ] Extend `frontend/src/api.ts` with `StridePMCRecord`, `StridePMCSummary`, and an additive `getPMC` response type.
- [ ] Extend `HealthPage.test.tsx` so mocked `getPMC` returns STRIDE rows and asserts the STRIDE section labels render.
- [ ] Run the targeted Vitest test and verify it fails before UI implementation.
- [ ] Update `HealthPage.tsx` to store `stride_pmc`/`stride_summary` and render a compact STRIDE section when rows exist.
- [ ] Run the targeted Vitest test and verify it passes.

### Task 4: Frontend Activity Detail STRIDE Panel

- [ ] Add `ActivityStrideTrainingLoad` and `stride_training_load` to `ActivityDetailResponse` in `frontend/src/api.ts`.
- [ ] Add an Activity Detail page test that mocks `getActivity`, asserts `手表负荷` appears for the vendor field, and asserts the STRIDE load panel renders when present.
- [ ] Run the targeted Vitest test and verify it fails before UI implementation.
- [ ] Update `ActivityDetailPage.tsx` to rename the vendor load label and render the optional STRIDE panel.
- [ ] Run the targeted Vitest test and verify it passes.

### Task 5: Verification And Commit

- [ ] Run targeted backend tests for training-load UI.
- [ ] Run frontend tests with `npm test` in `frontend/`.
- [ ] Run a production frontend build with `npm run build` in `frontend/`.
- [ ] Check `git diff` and confirm the changes are scoped.
- [ ] Commit the implementation.
