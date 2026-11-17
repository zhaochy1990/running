// derive_export.go exposes the canonical derivation seams the ordinary
// compute/ability paths use so the explicit historical-metrics recompute
// (devops#1012, epic devops#1004 T08) can derive the SAME artifacts into its
// staging set without a second algorithm: per-activity load, calibrated zones,
// the daily PMC series with its seed chain, per-activity L1 rows, and the
// current-day four-layer ability refresh. Every function here is the loop body
// the ordinary path runs; the ordinary path itself refactors onto them.
package compute

import (
	"context"
	"time"

	"github.com/zhaochy1990/stride/internal/compute/trainingload"
	"github.com/zhaochy1990/stride/internal/storage"
	"github.com/zhaochy1990/stride/internal/utils/timefmt"
)

// ErrHistoricalCalibrationMissing is the ordinary paths' sentinel for "the
// day/window has no historical calibration bundle" — exported so the explicit
// historical-metrics recompute (devops#1012) recognizes the same honest
// unavailable outcome when refreshing the current-day ability.
var ErrHistoricalCalibrationMissing = errHistoricalCalibrationMissing

// DeriveActivityLoad computes one loaded activity's training load against its
// Shanghai day's calibration bundle. ok=false means the day has NO historical
// calibration bundle: an honest skip — the caller keeps the activity's existing
// derived rows instead of borrowing another day's baseline (ADR 0045).
func DeriveActivityLoad(ctx context.Context, store ComputeStore, user string, a trainingload.ActivityInput) (trainingload.ActivityLoadResult, bool, error) {
	bundle, err := storage.ReadCachedRunningCalibration(ctx, store, user, timefmt.ShanghaiDayStr(a.ActivityDate), storage.CalibrationActive)
	if err != nil {
		return trainingload.ActivityLoadResult{}, false, err
	}
	if bundle.Snapshot == nil {
		return trainingload.ActivityLoadResult{}, false, nil
	}
	if err := checkActiveCalibrationWrite(ctx, bundle); err != nil {
		return trainingload.ActivityLoadResult{}, false, err
	}
	return trainingload.ComputeActivityLoad(a, toTrainingLoadCalibration(bundle.Snapshot)), true, nil
}

// DeriveActivityLoadRows maps computed results onto provenance-frozen storage
// rows (the same per-row freeze persistActivityLoad applies before writing).
func DeriveActivityLoadRows(ctx context.Context, store ComputeStore, user string, results []trainingload.ActivityLoadResult) ([]storage.ActivityTrainingLoad, error) {
	rows := mapActivityRows(user, results)
	for i := range rows {
		b, err := storage.ReadCachedRunningCalibration(ctx, store, user, rows[i].ActivityDate, storage.CalibrationActive)
		if err != nil {
			return nil, err
		}
		if err := storage.FreezeCalibrationProvenance(&rows[i], []storage.CalibrationInput{b.FrozenInput()}, nil); err != nil {
			return nil, err
		}
	}
	return rows, nil
}

// PriorDailyLoadSeed reads the last daily row strictly before day as the EWMA
// seed for a recompute window: a provenance-verifiable row seeds
// frozen_seed, a legacy row seeds legacy_seed_lineage_unavailable, and no row
// at all returns (nil, nil) — the caller's explicit zero anchor.
func PriorDailyLoadSeed(ctx context.Context, store ComputeStore, user string, day time.Time) (*trainingload.PriorLoadState, *storage.CalibrationSeed, error) {
	prior, err := priorLoadState(ctx, store, user, day)
	if err != nil {
		return nil, nil, err
	}
	if prior == nil {
		return nil, nil, nil
	}
	values := prior.PriorLoadState
	return &values, &prior.seed, nil
}

// ComputeDailySeries builds the daily PMC series for [start, end] from the
// given per-activity results and the user's health/HRV rows, seeded by prior
// state (nil = zero anchor). The same canonical series the ordinary compute
// path persists.
func ComputeDailySeries(ctx context.Context, store ComputeStore, user string, results []trainingload.ActivityLoadResult, start, end time.Time, prior *trainingload.PriorLoadState) ([]trainingload.DailyLoadResult, error) {
	return computeDaily(ctx, store, user, results, start, end, prior)
}

// DeriveDailyLoadRows maps daily results onto provenance-frozen storage rows
// and advances the seed chain exactly like the ordinary persist: each row
// freezes its own day's bundle (available or explicitly unavailable) and the
// seed actually used, and a provenance-verifiable row becomes the next day's
// frozen seed. Returns the rows and the seed to continue from.
func DeriveDailyLoadRows(ctx context.Context, store ComputeStore, user string, daily []trainingload.DailyLoadResult, seed *storage.CalibrationSeed) ([]storage.DailyTrainingLoad, *storage.CalibrationSeed, error) {
	rows := mapDailyRows(user, daily)
	for i := range rows {
		b, err := storage.ReadCachedRunningCalibration(ctx, store, user, rows[i].Date, storage.CalibrationActive)
		if err != nil {
			return nil, nil, err
		}
		inputs := []storage.CalibrationInput{b.FrozenInput()}
		if err := storage.FreezeCalibrationProvenance(&rows[i], inputs, seed); err != nil {
			return nil, nil, err
		}
		if p, state := storage.ReadCalibrationProvenance(rows[i]); state == "available" {
			seed = &storage.CalibrationSeed{Date: rows[i].Date, AcuteLoad: rows[i].AcuteLoad, ChronicLoad: rows[i].ChronicLoad, ProvenanceDigest: p.OutputDigest, State: "frozen_seed"}
		}
	}
	return rows, seed, nil
}

// PersistAbilityDay computes and persists the four-layer ability snapshot for
// one Shanghai day plus its L1 batch (labelIDs, else the day's activities) —
// the ordinary ability path, exported so the historical recompute refreshes
// the current-day ability (当天四层 ability 收口) through the same code after
// its L1 publication. Ultra-short activities are skipped; a missing as-of
// HRMax surfaces as errHistoricalCalibrationMissing.
func PersistAbilityDay(ctx context.Context, store AbilityStore, user string, day time.Time, labelIDs []string) (written, skipped, unavailable int, err error) {
	return computeAndPersist(ctx, store, user, day, labelIDs)
}
