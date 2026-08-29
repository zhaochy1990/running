// ability.go is the compute job handler that recomputes and persists the
// 4-layer ability snapshot. It mirrors Python post_ability_backfill /
// compute_ability_snapshot: per Shanghai day it loads the ability Source and
// upserts the long-form ability_snapshot rows (meta/L2/L3/L4). The sync pipeline
// drives this per-day; a standalone backfill mode seeds history over N days.
package compute

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/google/uuid"

	"github.com/zhaochy1990/stride/internal/compute/ability"
	"github.com/zhaochy1990/stride/internal/compute/abilitysource"
	"github.com/zhaochy1990/stride/internal/job"
	"github.com/zhaochy1990/stride/internal/storage"
	"github.com/zhaochy1990/stride/internal/utils/timefmt"
)

// AbilityJobType is the registered job_type for the ability snapshot handler.
const AbilityJobType = "ability"

// abilityInput is the optional job InputJSON. mode "full" (default) computes the
// current day only; "backfill" seeds the last `days` days. ref_date overrides the
// anchor Shanghai day (defaults to today).
type abilityInput struct {
	Mode    string `json:"mode"`
	Days    int    `json:"days"`
	RefDate string `json:"ref_date"`
}

// AbilityStore is the read+write surface the ability handler needs:
// the Source loader (activities/health/dashboard/pbs/calibration) + the snapshot,
// activity-ability, vo2max_pb writes, and personal_bests (to seed vo2max_pb).
type AbilityStore interface {
	abilitysource.Reader
	PersonalBests(ctx context.Context, userID string) ([]storage.PersonalBest, error)
	ReplaceAbilitySnapshot(ctx context.Context, userID string, rows []storage.AbilitySnapshot) error
	UpsertActivityAbility(ctx context.Context, userID string, row *storage.ActivityAbility) error
	UpsertVo2MaxPB(ctx context.Context, userID string, row *storage.Vo2MaxPB) error
}

type abilityResult struct {
	User   string `json:"user"`
	Status string `json:"status"`
	Days   int    `json:"days"`
}

// NewAbility builds the ability job handler. It computes the current-day snapshot
// (default) or a backfill over `days`, and persists the ability_snapshot rows.
func NewAbility(store AbilityStore) job.Handler {
	return func(ctx context.Context, j *job.Job, hb job.Heartbeat) (string, error) {
		user := j.UserID
		if _, err := uuid.Parse(user); err != nil {
			return "", job.NewPermanentError("bad_partition",
				fmt.Errorf("ability: partition key must be a user UUID: %w", err))
		}
		var in abilityInput
		if j.InputJSON != "" {
			if err := json.Unmarshal([]byte(j.InputJSON), &in); err != nil {
				return "", job.NewPermanentError("bad_input",
					fmt.Errorf("ability: bad input: %w", err))
			}
		}
		n, err := runAbility(ctx, store, user, in)
		if err != nil {
			return "", err
		}
		_ = hb("ability", 100)
		out, _ := json.Marshal(abilityResult{User: user, Status: "ok", Days: n})
		return string(out), nil
	}
}

func runAbility(ctx context.Context, store AbilityStore, user string, in abilityInput) (int, error) {
	ref, err := anchorDay(in.RefDate)
	if err != nil {
		return 0, job.NewPermanentError("bad_date", err)
	}

	// Seed vo2max_pb from the PB detector's personal_bests so the PB-memory
	// channel in compute_l3_vo2max has data (best-effort; the keep-higher-vdot
	// guard makes this idempotent). Done once, before the day loop.
	if err := seedVo2MaxPBs(ctx, store, user); err != nil {
		return 0, err
	}

	if in.Mode == "backfill" && in.Days > 1 {
		// Python post_ability_backfill iterates range(days+1) — days days back
		// plus the anchor day, inclusive. Mirror that (start..end inclusive).
		count := 0
		for i := 0; i <= in.Days; i++ {
			day := ref.AddDate(0, 0, -i)
			if _, err := computeAndPersist(ctx, store, user, day); err != nil {
				return count, err
			}
			count++
		}
		return count, nil
	}

	if _, err := computeAndPersist(ctx, store, user, ref); err != nil {
		return 0, err
	}
	return 1, nil
}

// computeAndPersist loads the Source, computes the snapshot for `day`, persists
// its ability_snapshot rows, and records the latest activity's L1 (best-effort).
func computeAndPersist(ctx context.Context, store AbilityStore, user string, day time.Time) (int, error) {
	src, err := abilitysource.Load(ctx, store, user, day, ability.AbilityLookbackDays)
	if err != nil {
		return 0, err
	}
	date := day.Format("2006-01-02")
	snap := ability.ComputeAbilitySnapshot(src, date, nil)
	rows := snapshotToRows(date, snap)
	if err := store.ReplaceAbilitySnapshot(ctx, user, rows); err != nil {
		return 0, err
	}

	// Best-effort: persist the latest activity's L1 so /activities/:id/ability
	// has a row. Contribution is deferred (needs prior/posterior L3). Skip when
	// no HRMax resolved (L1 needs it, and the snapshot is empty anyway).
	if len(src.Activities) > 0 && src.HRMax != nil {
		latest := src.Activities[0]
		l1 := ability.ComputeL1Quality(&latest, nil, *src.HRMax)
		breakdown, _ := json.Marshal(l1.Breakdown)
		bs := string(breakdown)
		stored := &storage.ActivityAbility{
			UserID:      user,
			LabelID:     latest.LabelID,
			L1Quality:   ptrF(l1.Total),
			L1Breakdown: &bs,
			ComputedAt:  time.Now().UTC(),
		}
		if err := store.UpsertActivityAbility(ctx, user, stored); err != nil {
			return 0, err
		}
	}
	return 1, nil
}

// snapshotToRows flattens a Snapshot into the long-form ability_snapshot rows,
// mirroring Python post_ability_backfill.
func snapshotToRows(date string, snap *ability.Snapshot) []storage.AbilitySnapshot {
	var rows []storage.AbilitySnapshot
	add := func(level, dimension string, value *float64, evidence []string) {
		rows = append(rows, storage.AbilitySnapshot{
			Date: date, Level: level, Dimension: dimension,
			Value: value, EvidenceActivityIDs: jsonOrNil(evidence),
		})
	}

	add("meta", "model_version", ptrF(float64(ability.AbilityModelVersion)), nil)

	if snap.L2Freshness != nil {
		add("L2", "total", ptrF(snap.L2Freshness.Total), nil)
	}

	l3 := &snap.L3Dimensions
	add("L3", "aerobic", ptrF(l3.Aerobic.Score), l3.Aerobic.Evidence)
	add("L3", "lt", ptrF(l3.LT.Score), l3.LT.Evidence)
	add("L3", "vo2max", ptrF(l3.VO2Max.Score), l3.VO2Max.Evidence)
	add("L3", "endurance", ptrF(l3.Endurance.Score), l3.Endurance.Evidence)
	add("L3", "economy", ptrF(l3.Economy.Score), l3.Economy.Evidence)
	add("L3", "recovery", ptrF(l3.Recovery.Score), l3.Recovery.Evidence)

	add("L4", "composite", ptrF(snap.L4Composite), snap.EvidenceActivityIDs)

	addEstimate := func(prefix string, e ability.MarathonEstimates) {
		if e.TrainingS != nil {
			add("L4", prefix+"_training_s", ptrF(float64(*e.TrainingS)), nil)
		}
		if e.RaceS != nil {
			add("L4", prefix+"_race_s", ptrF(float64(*e.RaceS)), nil)
		}
		if e.BestCaseS != nil {
			add("L4", prefix+"_best_case_s", ptrF(float64(*e.BestCaseS)), nil)
		}
	}
	addEstimate("marathon", snap.MarathonEstimates)
	addEstimate("hm", snap.HalfMarathonEstimates)

	return rows
}

func anchorDay(refDate string) (time.Time, error) {
	if refDate == "" {
		return timefmt.ShanghaiToday(), nil
	}
	t, err := time.Parse("2006-01-02", refDate)
	if err != nil {
		return time.Time{}, err
	}
	return t, nil
}

func ptrF(v float64) *float64 { return &v }

func jsonOrNil(ev []string) *string {
	if len(ev) == 0 {
		return nil
	}
	b, err := json.Marshal(ev)
	if err != nil {
		b = []byte("[]")
	}
	s := string(b)
	return &s
}

// seedVo2MaxPBs derives a per-race-type best VDOT from the PB detector's
// personal_bests and upserts vo2max_pb rows, fueling the PB-memory channel in
// compute_l3_vo2max. The keep-higher-vdot guard makes re-runs idempotent. Only
// the canonical race distances populate a VDOT (1K/3K display PBs are skipped).
func seedVo2MaxPBs(ctx context.Context, store AbilityStore, user string) error {
	pbs, err := store.PersonalBests(ctx, user)
	if err != nil {
		return err
	}
	for i := range pbs {
		pb := &pbs[i]
		raceType := pb.Distance
		if raceType != "5K" && raceType != "10K" && raceType != "HM" && raceType != "FM" {
			continue
		}
		distM := raceDistanceM(raceType)
		if distM <= 0 || pb.PBTimeSec <= 0 {
			continue
		}
		raceTypeArg := raceType
		if raceType == "FM" {
			raceTypeArg = "full"
		}
		vdot := ability.ComputePBVdotForSegment(raceTypeArg, distM, pb.PBTimeSec)
		if vdot == nil {
			continue
		}
		row := &storage.Vo2MaxPB{
			RaceType:  raceType,
			DistanceM: ptrF(distM),
			DurationS: ptrF(pb.PBTimeSec),
			Vdot:      vdot,
			PBDate:    strOrEmpty(pb.AchievedAt),
			EvenPaced: true,
		}
		if err := store.UpsertVo2MaxPB(ctx, user, row); err != nil {
			return err
		}
	}
	return nil
}

func raceDistanceM(raceType string) float64 {
	switch raceType {
	case "5K":
		return 5000
	case "10K":
		return 10000
	case "HM":
		return 21097.5
	case "FM":
		return 42195
	}
	return 0
}

func strOrEmpty(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}
