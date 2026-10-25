package sessionclass

import (
	"testing"

	"github.com/zhaochy1990/stride/internal/storage"
)

func fptr(v float64) *float64 { return &v }

func TestFineLapsDedupsOverlappingLapSystems(t *testing.T) {
	// COROS stores 1 km (type2) alongside 5 km (autoMile) and 10 km (type12)
	// summaries of the same run; summing all three triple-counts distance.
	laps := []storage.Lap{
		{LapType: "type2", DistanceM: fptr(1000), DurationS: fptr(300)},
		{LapType: "autoMile", DistanceM: fptr(5000), DurationS: fptr(1500)},
		{LapType: "type12", DistanceM: fptr(10000), DurationS: fptr(3000)},
		{LapType: "type2", DistanceM: fptr(1000), DurationS: fptr(290)},
		{LapType: "type2", DistanceM: fptr(1000), DurationS: fptr(280)},
	}
	got := FineLaps(laps)
	if len(got) != 3 {
		t.Fatalf("FineLaps = %d laps, want the 3 type2 splits only", len(got))
	}
	// Garmin autoKm fallback when no 1 km COROS laps exist.
	garmin := []storage.Lap{
		{LapType: "autoKm", DistanceM: fptr(1000), DurationS: fptr(300)},
		{LapType: "autoKm", DistanceM: fptr(1000), DurationS: fptr(310)},
	}
	if got := FineLaps(garmin); len(got) != 2 {
		t.Fatalf("FineLaps(autoKm) = %d, want 2", len(got))
	}
}

func TestClassifyTicketNegativeCases(t *testing.T) {
	// Ticket acceptance: a 35 km easy long run (ae 4.1, ane < 1) must stay
	// long_easy — aerobic effect is polluted by duration.
	got := Classify(Input{
		Sport: "run_outdoor", Name: "上海市 跑步", DistanceM: 35000, DurationS: 139 * 60,
		AvgPaceSKm: fptr(239), AvgHR: fptr(141), MaxHR: fptr(154),
		AerobicEffect: fptr(4.1), AnaerobicEffect: fptr(1.5), TrainKind: "aerobic",
		ThresholdHR: fptr(165), Zones: &Zones{Marathon: &Zone{Fast: fptr(212), Slow: fptr(246)}},
	})
	if got.Class != ClassLongEasy {
		t.Fatalf("35km easy long run = %s, want long_easy (%v)", got.Class, got.Signals)
	}

	// Treadmill intervals with ane 3.1 must not be missed despite the slow
	// average pace (flat-road pace never vetoes intensity).
	got = Classify(Input{
		Sport: "run_treadmill", Name: "跑步机", DistanceM: 7700, DurationS: 46 * 60,
		AvgPaceSKm: fptr(361), AvgHR: fptr(139), MaxHR: fptr(162),
		AerobicEffect: fptr(2.2), AnaerobicEffect: fptr(3.1), TrainKind: "aerobic",
		AscentM: fptr(449),
	})
	if got.Class != ClassQuality {
		t.Fatalf("treadmill intervals ane=3.1 = %s, want quality (%v)", got.Class, got.Signals)
	}

	// hr=0 sessions must not depend on HR and must not crash.
	got = Classify(Input{
		Sport: "run_outdoor", Name: "间歇跑（800m快+400m慢+800快）", DistanceM: 10250, DurationS: 58 * 60,
		AvgPaceSKm: fptr(336), TrainKind: "interval",
	})
	if got.Class != ClassQuality {
		t.Fatalf("no-strap intervals = %s, want quality (%v)", got.Class, got.Signals)
	}

	// Vendor noise rejection: Garmin TEMPO label on an easy-pace run without
	// corroboration stays easy (the pre-#743 passthrough misfired here).
	got = Classify(Input{
		Sport: "run_outdoor", Name: "青浦区 跑步", DistanceM: 10050, DurationS: 55 * 60,
		AvgPaceSKm: fptr(295), AvgHR: fptr(142), MaxHR: fptr(160),
		AerobicEffect: fptr(3.6), AnaerobicEffect: fptr(0), TrainKind: "tempo", TrainType: "TEMPO",
		ThresholdHR: fptr(167), Zones: &Zones{Marathon: &Zone{Fast: fptr(239), Slow: fptr(276)}, Threshold: &Zone{Fast: fptr(225), Slow: fptr(239)}},
	})
	if got.Class != ClassEasy {
		t.Fatalf("uncorroborated TEMPO label = %s, want easy (%v)", got.Class, got.Signals)
	}

	// Race detection reuse: a races-table-linked half marathon is race even
	// when the watch labeled it interval.
	got = Classify(Input{
		Sport: "run_outdoor", Name: "东营市 跑步", DistanceM: 21190, DurationS: 76 * 60,
		AvgPaceSKm: fptr(215), AvgHR: fptr(180), MaxHR: fptr(193),
		AerobicEffect: fptr(3.8), AnaerobicEffect: fptr(4.3), TrainKind: "interval",
		RaceLinked: true, ThresholdHR: fptr(177.5), HRMaxEstimate: fptr(196),
	})
	if got.Class != ClassRace {
		t.Fatalf("races-linked activity = %s, want race (%v)", got.Class, got.Signals)
	}

	// Hikes never become long runs by duration.
	got = Classify(Input{
		Sport: "run_trail", Name: "宁波市 越野跑", DistanceM: 5070, DurationS: 136 * 60,
		AvgPaceSKm: fptr(1606), AvgHR: fptr(93), MaxHR: fptr(121), TrainKind: "aerobic",
	})
	if got.Class != ClassEasy {
		t.Fatalf("hike = %s, want easy (%v)", got.Class, got.Signals)
	}
}

func TestZonesFromStorage(t *testing.T) {
	z := ZonesFromStorage([]storage.RunningCalibrationPaceZone{
		{Name: "marathon", MinPaceSPerKm: fptr(213), MaxPaceSPerKm: fptr(246)},
		{Name: "threshold", MinPaceSPerKm: fptr(200), MaxPaceSPerKm: fptr(213)},
		{Name: "weird-zone", MinPaceSPerKm: fptr(1), MaxPaceSPerKm: fptr(2)},
	})
	if z == nil || z.Marathon == nil || *z.Marathon.Slow != 246 || z.Threshold == nil {
		t.Fatalf("ZonesFromStorage = %+v", z)
	}
	if ZonesFromStorage(nil) != nil {
		t.Fatal("ZonesFromStorage(nil) must be nil")
	}
	if ZonesFromStorage([]storage.RunningCalibrationPaceZone{{Name: "easy"}}) != nil {
		t.Fatal("zones without marathon must degrade to nil")
	}
}
