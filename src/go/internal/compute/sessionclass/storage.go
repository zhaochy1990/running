package sessionclass

import (
	"strings"

	"github.com/zhaochy1990/stride/internal/compute/watchmap"
	"github.com/zhaochy1990/stride/internal/storage"
)

// FromStorage builds the classifier input from storage rows. Laps may be nil
// (degraded path); zones from the user's latest calibration snapshot may be
// nil for uncalibrated users; raceLinked comes from the races table.
func FromStorage(a storage.Activity, laps []storage.Lap, zones *Zones, thresholdHR, hrmaxEstimate *float64, raceLinked bool) Input {
	in := Input{
		Name:            derefStr(a.Name),
		Sport:           watchmap.SportFromRow(a.Sport, a.SportType),
		DistanceM:       derefF(a.DistanceM),
		DurationS:       derefF(a.DurationS),
		AvgPaceSKm:      a.AvgPaceSKm,
		BestKmPaceSKm:   a.BestKmPace,
		AvgHR:           intToFloat(a.AvgHR),
		MaxHR:           intToFloat(a.MaxHR),
		AscentM:         a.AscentM,
		AerobicEffect:   a.AerobicEffect,
		AnaerobicEffect: a.AnaerobicEffect,
		ThresholdHR:     thresholdHR,
		HRMaxEstimate:   hrmaxEstimate,
		Zones:           zones,
		RaceLinked:      raceLinked,
	}
	if a.TrainKind != nil {
		in.TrainKind = strings.TrimSpace(*a.TrainKind)
	}
	if a.TrainType != nil {
		in.TrainType = strings.TrimSpace(*a.TrainType)
	}
	in.Laps = FineLaps(laps)
	return in
}

// FineLaps selects the non-overlapping 1 km lap set. Providers store multiple
// overlapping lap systems (COROS type2=1 km alongside autoMile=5 km and
// type12=10 km summaries); summing all of them double-counts distance.
func FineLaps(rows []storage.Lap) []Lap {
	var fine, mile, any []Lap
	for i := range rows {
		l := rows[i]
		if l.DistanceM == nil || *l.DistanceM <= 100 {
			continue
		}
		conv := Lap{DistanceM: *l.DistanceM, DurationS: derefF(l.DurationS), AvgHR: intToFloat(l.AvgHR)}
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

// ZonesFromStorage converts the latest snapshot's pace zones. Zone names use
// the calibration package's vocabulary (repetition/interval/threshold/
// marathon/easy/recovery); unknown names are ignored.
func ZonesFromStorage(rows []storage.RunningCalibrationPaceZone) *Zones {
	if len(rows) == 0 {
		return nil
	}
	z := &Zones{}
	for i := range rows {
		r := rows[i]
		zone := &Zone{Fast: r.MinPaceSPerKm, Slow: r.MaxPaceSPerKm}
		switch strings.ToLower(strings.TrimSpace(r.Name)) {
		case "easy", "recovery":
			z.Easy = zone
		case "marathon":
			z.Marathon = zone
		case "threshold":
			z.Threshold = zone
		case "interval":
			z.Interval = zone
		case "repetition":
			z.Repetition = zone
		}
	}
	if z.Marathon == nil {
		return nil
	}
	return z
}

func derefStr(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

func derefF(f *float64) float64 {
	if f == nil {
		return 0
	}
	return *f
}

func intToFloat(i *int) *float64 {
	if i == nil {
		return nil
	}
	v := float64(*i)
	return &v
}
