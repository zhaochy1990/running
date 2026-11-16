package onboardingsync

// onboarding_coach_fixture_test.go is the Go-owned bridge of devops#1013
// (Coach 理解同步覆盖): it seeds one realistic session through the REAL
// storage methods in an isolated MySQL and exports the REAL View projection,
// so the TS MySqlDataProvider.getSyncCoverage test can read the very rows Go
// wrote and assert the coach-side derivation agrees with the API view
// (近期可问、长期结论明确受限的跨语言集成验证 seam).
//
// It only runs when STRIDE_1013_FIXTURE_OUTPUT is set (the CI/dev flow
// attaches the database selectively; plain `go test ./...` stays green).

import (
	"context"
	"encoding/json"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/zhaochy1990/stride/internal/storage"
)

func TestOnboardingCoachSharedFixture(t *testing.T) {
	out := os.Getenv("STRIDE_1013_FIXTURE_OUTPUT")
	if out == "" {
		t.Skip("explicit shared fixture output required")
	}
	h := newHarness(t)
	ctx := context.Background()
	uid := uuid.NewString()
	provider := "coros"
	if err := h.store.SaveCredential(ctx, &storage.ProviderCredential{
		UserID: uid, Provider: provider, UpdatedAt: time.Now().UTC(),
	}); err != nil {
		t.Fatalf("credential: %v", err)
	}
	sess, err := h.svc.CreateOrClaim(ctx, uid, provider)
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	// No row cleanup, matching this package's suite convention: every run
	// seeds a fresh random user in the dedicated throwaway database, so the
	// rows are inert residue the operator drops with the database itself.

	// Realistic mid-onboarding shape: recent raw complete with a vendor gap,
	// analysis published partial (load unavailable) and stale, history walking.
	recentRaw, err := h.store.GetOnboardingSyncStageCoverage(ctx, sess.SessionID, storage.OnboardingSyncStageRecentRaw)
	if err != nil || recentRaw == nil {
		t.Fatalf("recent_raw coverage: %+v %v", recentRaw, err)
	}
	recentRaw.Status = storage.OnboardingSyncCoverageCompleted
	recentRaw.ScannedFrom, recentRaw.ScannedTo = &recentRaw.TargetFrom, &recentRaw.TargetTo
	recentRaw.ObservedFrom, recentRaw.ObservedTo = &recentRaw.TargetFrom, &recentRaw.TargetTo
	gaps := `[{"from":"2026-09-01","to":"2026-09-02","reason":"vendor unavailable"}]`
	recentRaw.GapsJSON = &gaps
	if err := h.store.UpdateOnboardingSyncStageCoverage(ctx, recentRaw); err != nil {
		t.Fatalf("update recent_raw: %v", err)
	}

	domains := `{"calibration":{"status":"ready"},"load":{"status":"unavailable","reason":"missing historical calibration"}}`
	asOfDay := time.Now().UTC().AddDate(0, 0, -1).Format("2006-01-02")
	// The analysis stage row is armed by the sweep once raw completes; stand it
	// in directly so the fixture also exercises the analysis derivation path.
	if err := h.store.EnsureOnboardingSyncStage(ctx, sess.SessionID, storage.OnboardingSyncStageRecentAnalysis, recentRaw.TargetFrom, recentRaw.TargetTo, "fixture-recent-analysis"); err != nil {
		t.Fatalf("ensure recent_analysis: %v", err)
	}
	analysisCov, err := h.store.GetOnboardingSyncStageCoverage(ctx, sess.SessionID, storage.OnboardingSyncStageRecentAnalysis)
	if err != nil || analysisCov == nil {
		t.Fatalf("recent_analysis coverage: %+v %v", analysisCov, err)
	}
	analysisCov.Status = storage.OnboardingSyncCoverageCompletedWithGaps
	if err := h.store.UpdateOnboardingSyncStageCoverage(ctx, analysisCov); err != nil {
		t.Fatalf("update recent_analysis: %v", err)
	}
	if err := h.store.UpsertOnboardingRecentAnalysis(ctx, &storage.OnboardingRecentAnalysis{
		SessionID: sess.SessionID, UserID: uid,
		AsOfDay: asOfDay, AnchorDay: sess.AnchorDay,
		InputFingerprint: "fixture-fingerprint", PolicyVersion: 1, PolicyRevision: 1,
		Status:       storage.OnboardingAnalysisStatusPartial,
		DomainsJSON:  &domains,
		CoverageFrom: &recentRaw.TargetFrom, CoverageTo: &recentRaw.TargetTo,
		Stale:      true,
		ComputedAt: time.Now().UTC(),
	}); err != nil {
		t.Fatalf("upsert analysis: %v", err)
	}

	for _, stage := range []string{storage.OnboardingSyncStageExtendedRaw, storage.OnboardingSyncStageHistoricalRaw} {
		if err := h.store.EnsureOnboardingSyncStage(ctx, sess.SessionID, stage, "2000-01-01", "2026-08-11", "fixture-"+stage); err != nil {
			t.Fatalf("ensure %s: %v", stage, err)
		}
		cov, err := h.store.GetOnboardingSyncStageCoverage(ctx, sess.SessionID, stage)
		if err != nil || cov == nil {
			t.Fatalf("%s coverage: %+v %v", stage, cov, err)
		}
		cov.Status = storage.OnboardingSyncCoverageRunning
		obsFrom, obsTo := "2026-06-01", "2026-08-11"
		cov.ObservedFrom, cov.ObservedTo = &obsFrom, &obsTo
		if err := h.store.UpdateOnboardingSyncStageCoverage(ctx, cov); err != nil {
			t.Fatalf("update %s: %v", stage, err)
		}
	}

	// The projection the coach must reproduce — derived by the real View.
	view, err := h.svc.View(ctx, uid)
	if err != nil {
		t.Fatalf("view: %v", err)
	}
	stageReadiness := map[string]string{}
	for _, sv := range view.Stages {
		stageReadiness[sv.Stage] = string(sv.Readiness)
	}
	fixture := map[string]any{
		"user_id":             uid,
		"session_id":          view.SessionID,
		"recent_data":         string(view.Readiness.RecentData),
		"recent_analysis":     string(view.Readiness.RecentAnalysis),
		"extended_data":       string(view.Readiness.ExtendedData),
		"historical_data":     string(view.Readiness.HistoricalData),
		"historical_analysis": string(view.Readiness.HistoricalAnalysis),
		"as_of_day":           "",
		"stage_readiness":     stageReadiness,
	}
	if view.RecentAnalysis != nil {
		fixture["as_of_day"] = view.RecentAnalysis.AsOfDay
		fixture["analysis_stale"] = view.RecentAnalysis.Stale
		fixture["analysis_status"] = view.RecentAnalysis.Status
	}
	raw, err := json.Marshal(fixture)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if err := os.WriteFile(out, raw, 0o644); err != nil {
		t.Fatalf("write fixture: %v", err)
	}
	t.Logf("shared fixture written to %s (session %s)", out, view.SessionID)
}
