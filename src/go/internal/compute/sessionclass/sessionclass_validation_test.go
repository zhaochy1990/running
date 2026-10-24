package sessionclass

import (
	"compress/gzip"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"testing"
)

// fixture mirrors the full-corpus dump (21 users × all running rows,
// 21006 items, per-item adjudicated ground truth; see the #743 PR for the
// adjudication methodology).
type fixture struct {
	Users []struct {
		UserID        string              `json:"user_id"`
		ThresholdHR   *float64            `json:"threshold_hr"`
		HRMaxEstimate *float64            `json:"hrmax_estimate"`
		PaceZones     map[string]zoneJSON `json:"pace_zones"`
		Activities    []struct {
			Label      string   `json:"label_id"`
			Date       string   `json:"date"`
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
				LapType   string   `json:"lap_type"`
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
	f, err := os.Open("testdata/sessionclass_validation.json.gz")
	if err != nil {
		tb.Fatalf("open fixture: %v", err)
	}
	defer f.Close()
	zr, err := gzip.NewReader(f)
	if err != nil {
		tb.Fatalf("gzip fixture: %v", err)
	}
	raw, err := io.ReadAll(zr)
	if err != nil {
		tb.Fatalf("read fixture: %v", err)
	}
	var fx fixture
	if err := json.Unmarshal(raw, &fx); err != nil {
		tb.Fatalf("parse fixture: %v", err)
	}
	var out []struct {
		uid   string
		input Input
		truth Class
	}
	for _, u := range fx.Users {
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
			}{u.UserID[:8], in, Class(a.Truth)})
		}
	}
	if len(out) != 21006 {
		tb.Fatalf("fixture has %d items, want 21006", len(out))
	}
	return out
}

// TestValidationAccuracy is the #743 acceptance gate over the full production
// corpus (21 users, all running rows): every class must hold ≥95% precision
// AND recall, with the overall accuracy ≥97%.
func TestValidationAccuracy(t *testing.T) {
	items := loadFixture(t)
	type stats struct{ total, correct int }
	overall := stats{}
	byPred := map[Class]*stats{}
	byTruth := map[Class]*stats{}
	var misses []string
	for _, it := range items {
		got := Classify(it.input)
		overall.total++
		if byPred[got.Class] == nil {
			byPred[got.Class] = &stats{}
		}
		if byTruth[it.truth] == nil {
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
			misses = append(misses, fmt.Sprintf("%s %q %.1fkm %.0fmin hr %v/%v ae %v ane %v kind=%s tt=%s pred=%s truth=%s",
				it.uid, trunc(a.Name, 18), a.DistanceM/1000, a.DurationS/60, fp(a.AvgHR), fp(a.MaxHR), fp(a.AerobicEffect), fp(a.AnaerobicEffect), a.TrainKind, a.TrainType, got.Class, it.truth))
		}
	}
	acc := float64(overall.correct) / float64(overall.total)
	for _, c := range []Class{ClassEasy, ClassLongEasy, ClassQuality, ClassLongQuality, ClassRace} {
		if s := byPred[c]; s != nil && s.total > 0 {
			t.Logf("%s: precision %.1f%% (%d)", c, 100*float64(s.correct)/float64(s.total), s.total)
		}
		if s := byTruth[c]; s != nil && s.total > 0 {
			t.Logf("%s: recall    %.1f%% (%d)", c, 100*float64(s.correct)/float64(s.total), s.total)
		}
	}
	t.Logf("overall: %d/%d = %.2f%%", overall.correct, overall.total, acc*100)

	_ = os.MkdirAll("/tmp/sc743", 0o755)
	_ = os.WriteFile("/tmp/sc743/fixture_misses.txt", []byte(joinLines(misses)), 0o644)

	if acc < 0.97 {
		t.Fatalf("overall accuracy %.2f%% < 97%%", acc*100)
	}
	for _, c := range []Class{ClassEasy, ClassLongEasy, ClassQuality, ClassLongQuality, ClassRace} {
		if s := byPred[c]; s != nil && s.total > 0 && float64(s.correct)/float64(s.total) < 0.95 {
			t.Errorf("%s precision %.1f%% < 95%%", c, 100*float64(s.correct)/float64(s.total))
		}
		if s := byTruth[c]; s != nil && s.total > 0 && float64(s.correct)/float64(s.total) < 0.95 {
			t.Errorf("%s recall %.1f%% < 95%%", c, 100*float64(s.correct)/float64(s.total))
		}
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
