package sessionclass

import (
	"encoding/json"
	"fmt"
	"os"
	"testing"
	"time"
)

// TestFullCorpusDump runs the classifier over a full production snapshot (all
// users, all running rows) and dumps per-item predictions plus a review
// evidence file. Skipped unless SC_FULL_SNAPSHOT points at the snapshot JSON
// and SC_FULL_OUT at an output directory — this is the ops-side validation
// harness for backfills and rule changes, not part of CI.
func TestFullCorpusDump(t *testing.T) {
	path := os.Getenv("SC_FULL_SNAPSHOT")
	outDir := os.Getenv("SC_FULL_OUT")
	if path == "" || outDir == "" {
		t.Skip("set SC_FULL_SNAPSHOT and SC_FULL_OUT to dump full-corpus predictions")
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read snapshot: %v", err)
	}
	var f fixture
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatalf("parse snapshot: %v", err)
	}
	type pred struct {
		UID     string   `json:"uid"`
		Label   string   `json:"label"`
		Idx     int      `json:"i"`
		Pred    string   `json:"pred"`
		Sub     string   `json:"sub"`
		Conf    string   `json:"conf"`
		Signals []string `json:"sig"`
	}
	preds := make([]pred, 0, 21000)
	var review []byte
	idx := 0
	counts := map[string]int{}
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
			idx++

			in := Input{
				Name: a.Name, Sport: a.Sport, DistanceM: a.DistanceM, DurationS: a.DurationS,
				AvgPaceSKm: a.AvgPace, BestKmPaceSKm: a.BestPace, AvgHR: a.AvgHR, MaxHR: a.MaxHR,
				AscentM: a.AscentM, AerobicEffect: a.AE, AnaerobicEffect: a.ANE,
				TrainKind: a.TrainKind, TrainType: a.TrainType,
				ThresholdHR: u.ThresholdHR, HRMaxEstimate: u.HRMaxEstimate,
				Zones: zones, Laps: fineLapsFiltered(a.Laps), RaceLinked: a.RaceLinked,
			}
			got := Classify(in)
			counts[string(got.Class)]++
			preds = append(preds, pred{u.UserID, a.Label, idx, string(got.Class), string(got.Subtype), got.Confidence, got.Signals})
			ls := lapSummaryForReview(in, zones, u.ThresholdHR)
			review = append(review, []byte(fmt.Sprintf("#%d %s %s 「%s」 %.1fkm %.0f' %s(b%s) hr%s/%s ae%s an%s asc%s k=%s t=%s %s | %s | => %s [%s] %v\n",
				idx, u.UserID, day(a.Date), trunc(a.Name, 26), a.DistanceM/1000, a.DurationS/60,
				paceStr(a.AvgPace), paceStr(a.BestPace), fp(a.AvgHR), fp(a.MaxHR), fp(a.AE), fp(a.ANE), fp(a.AscentM),
				a.TrainKind, a.TrainType, raceMark(a.RaceLinked), ls, string(got.Class), got.Confidence, got.Signals))...)
		}
	}
	pj, _ := json.Marshal(preds)
	if err := os.WriteFile(outDir+"/predictions_full.json", pj, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(outDir+"/review_full.txt", review, 0o644); err != nil {
		t.Fatal(err)
	}
	t.Logf("classified %d items: %v", idx, counts)
}

func paceStr(v *float64) string {
	if v == nil {
		return "-"
	}
	s := int(*v)
	return fmt.Sprintf("%d'%02d", s/60, s%60)
}

func day(s string) string {
	if len(s) >= 10 {
		return s[:10]
	}
	return s
}

func raceMark(b bool) string {
	if b {
		return "R"
	}
	return ""
}

// lapSummaryForReview renders the compact lap-evidence block used during
// per-item adjudication (same fields the earlier validation round used).
func lapSummaryForReview(in Input, zones *Zones, thrHr *float64) string {
	mSlow := zoneSlow(zones, func(z *Zones) **Zone { return &z.Marathon })
	tSlow := zoneSlow(zones, func(z *Zones) **Zone { return &z.Threshold })
	ls := lapStats(in.Laps, mSlow, tSlow, thrHr)
	if ls == nil {
		return "L:-"
	}
	return fmt.Sprintf("L:n%d tail%.2f cv%.2f tHr%.0f thr%.2f m%.0f%% fast%.0f%%",
		ls.NLaps, ls.TailRatio, ls.CV, ls.TailHR, ls.ThrHrTimePct, ls.MZoneFrac*100, ls.FastDistPct*100)
}

var _ = time.Now

// fineLapsFiltered mirrors storage.FineLaps: providers overlap 1 km
// (type2/autoKm), 5 km (autoMile) and 10 km (type12) lap systems; only the
// 1 km set may be summed.
func fineLapsFiltered(rows []struct {
	DistanceM float64  `json:"distance_m"`
	DurationS float64  `json:"duration_s"`
	AvgHR     *float64 `json:"avg_hr"`
	LapType   string   `json:"lap_type"`
}) []Lap {
	var fine, mile, any []Lap
	for _, l := range rows {
		if l.DistanceM <= 100 {
			continue
		}
		conv := Lap{DistanceM: l.DistanceM, DurationS: l.DurationS, AvgHR: l.AvgHR}
		switch l.LapType {
		case "type2", "autoKm":
			fine = append(fine, conv)
		case "autoMile":
			mile = append(mile, conv)
		}
		any = append(any, conv)
	}
	if len(fine) >= 2 {
		return fine
	}
	if len(mile) >= 2 {
		return mile
	}
	return any
}
