package sessionclass

import (
	"encoding/json"
	"fmt"
	"os"
	"testing"
)

// fixture mirrors gen script output (prod snapshot 2026-10-24 + per-item
// adjudicated ground truth).
type fixture struct {
	Users []struct {
		UserID        string              `json:"user_id"`
		ThresholdHR   *float64            `json:"threshold_hr"`
		HRMaxEstimate *float64            `json:"hrmax_estimate"`
		PaceZones     map[string]zoneJSON `json:"pace_zones"`
		Activities    []struct {
			Idx        int      `json:"idx"`
			Name       string   `json:"name"`
			Sport      string   `json:"sport"`
			DistanceM  float64  `json:"distance_m"`
			DurationS  float64  `json:"duration_s"`
			AvgPace    *float64 `json:"avg_pace_s_km"`
			BestPace   *float64 `json:"best_km_pace"`
			AvgHR      *float64 `json:"avg_hr"`
			MaxHR      *float64 `json:"max_hr"`
			AscentM    *float64 `json:"ascent_m"`
			AE         *float64 `json:"aerobic_effect"`
			ANE        *float64 `json:"anaerobic_effect"`
			TrainKind  string   `json:"train_kind"`
			TrainType  string   `json:"train_type"`
			RaceLinked bool     `json:"race_linked"`
			Truth      string   `json:"truth"`
			Laps       []struct {
				DistanceM float64  `json:"distance_m"`
				DurationS float64  `json:"duration_s"`
				AvgHR     *float64 `json:"avg_hr"`
			} `json:"laps"`
		} `json:"activities"`
	}
}

type zoneJSON struct {
	Fast *float64 `json:"fast"`
	Slow *float64 `json:"slow"`
}

func loadFixture(tb testing.TB) []struct {
	uid   string
	input Input
	truth Class
} {
	raw, err := os.ReadFile("testdata/sessionclass_validation.json")
	if err != nil {
		tb.Fatalf("read fixture: %v", err)
	}
	var f fixture
	if err := json.Unmarshal(raw, &f); err != nil {
		tb.Fatalf("parse fixture: %v", err)
	}
	var out []struct {
		uid   string
		input Input
		truth Class
	}
	for _, u := range f.Users {
		var zones *Zones
		if len(u.PaceZones) > 0 {
			z := &Zones{}
			assign := func(dst **Zone, key string) {
				if v, ok := u.PaceZones[key]; ok {
					*dst = &Zone{Fast: v.Fast, Slow: v.Slow}
				}
			}
			assign(&z.Easy, "easy")
			assign(&z.Marathon, "marathon")
			assign(&z.Threshold, "threshold")
			assign(&z.Interval, "interval")
			assign(&z.Repetition, "repetition")
			zones = z
		}
		for _, a := range u.Activities {
			laps := make([]Lap, 0, len(a.Laps))
			for _, l := range a.Laps {
				laps = append(laps, Lap{DistanceM: l.DistanceM, DurationS: l.DurationS, AvgHR: l.AvgHR})
			}
			in := Input{
				Name: a.Name, Sport: a.Sport, DistanceM: a.DistanceM, DurationS: a.DurationS,
				AvgPaceSKm: a.AvgPace, BestKmPaceSKm: a.BestPace, AvgHR: a.AvgHR, MaxHR: a.MaxHR,
				AscentM: a.AscentM, AerobicEffect: a.AE, AnaerobicEffect: a.ANE,
				TrainKind: a.TrainKind, TrainType: a.TrainType,
				ThresholdHR: u.ThresholdHR, HRMaxEstimate: u.HRMaxEstimate,
				Zones: zones, Laps: laps, RaceLinked: a.RaceLinked,
			}
			out = append(out, struct {
				uid   string
				input Input
				truth Class
			}{u.UserID, in, Class(a.Truth)})
		}
	}
	return out
}

// TestValidationAccuracy is the #743 acceptance gate: the adjudicated
// production snapshot must classify at ≥95% overall, with easy/quality ≥90%
// precision and long_quality ≥85% (ticket thresholds).
func TestValidationAccuracy(t *testing.T) {
	items := loadFixture(t)
	type stats struct{ total, correct int }
	overall := stats{}
	byPred := map[Class]*stats{}
	byTruth := map[Class]*stats{}
	var misses []string
	idx := 0
	for _, it := range items {
		idx++
		got := Classify(it.input)
		overall.total++
		if p := byPred[got.Class]; p == nil {
			byPred[got.Class] = &stats{}
		}
		if p := byTruth[it.truth]; p == nil {
			byTruth[it.truth] = &stats{}
		}
		byPred[got.Class].total++
		byTruth[it.truth].total++
		if got.Class == it.truth {
			overall.correct++
			byPred[got.Class].correct++
			byTruth[it.truth].correct++
		} else {
			a := it.input
			misses = append(misses, fmt.Sprintf("idx=%d %s %q sport=%s %.1fkm %.0fmin pace=%v hr %v/%v ae %v ane %v kind=%s tt=%s pred=%s truth=%s sig=%v",
				idx, it.uid, trunc(a.Name, 18), a.Sport, a.DistanceM/1000, a.DurationS/60, fp(a.AvgPaceSKm), fp(a.AvgHR), fp(a.MaxHR), fp(a.AerobicEffect), fp(a.AnaerobicEffect), a.TrainKind, a.TrainType, got.Class, it.truth, got.Signals))
		}
	}
	acc := float64(overall.correct) / float64(overall.total)
	precision := func(c Class) (float64, bool) {
		if s := byPred[c]; s != nil && s.total > 0 {
			return float64(s.correct) / float64(s.total), true
		}
		return 0, false
	}
	recall := func(c Class) (float64, bool) {
		if s := byTruth[c]; s != nil && s.total > 0 {
			return float64(s.correct) / float64(s.total), true
		}
		return 0, false
	}

	os.MkdirAll("/tmp/sc743", 0o755)
	os.WriteFile("/tmp/sc743/go_misses.txt", []byte(joinLines(misses)), 0o644)

	t.Logf("overall: %d/%d = %.1f%%", overall.correct, overall.total, acc*100)
	for _, c := range []Class{ClassEasy, ClassLongEasy, ClassQuality, ClassLongQuality, ClassRace} {
		p, pok := precision(c)
		rc, rcok := recall(c)
		if pok {
			t.Logf("%s: precision %.1f%% (%d)", c, p*100, byPred[c].total)
		}
		if rcok {
			t.Logf("%s: recall    %.1f%% (%d)", c, rc*100, byTruth[c].total)
		}
	}

	if acc < 0.95 {
		t.Fatalf("overall accuracy %.1f%% < 95%%; misses written to /tmp/sc743/go_misses.txt", acc*100)
	}
	for _, c := range []Class{ClassEasy, ClassQuality} {
		if p, ok := precision(c); ok && p < 0.90 {
			t.Errorf("%s precision %.1f%% < 90%%", c, p*100)
		}
	}
	if p, ok := precision(ClassLongQuality); ok && p < 0.85 {
		t.Errorf("long_quality precision %.1f%% < 85%%", p*100)
	}
}

func trunc(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n])
}

func fp(v *float64) string {
	if v == nil {
		return "-"
	}
	return fmt.Sprintf("%.1f", *v)
}

func joinLines(ss []string) string {
	out := ""
	for _, s := range ss {
		out += s + "\n"
	}
	return out
}
