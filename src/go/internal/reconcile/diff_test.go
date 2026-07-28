package reconcile

import "testing"

func fields() []Field {
	return []Field{
		{Name: "sport", Kind: Exact},
		{Name: "avg_hr", Kind: Exact},
		{Name: "distance_m", Kind: Float, Tol: 0.011},
	}
}

func TestDiff_Identical(t *testing.T) {
	a := map[string]Row{"L1": {"sport": "run_outdoor", "avg_hr": int64(150), "distance_m": 10000.0}}
	b := map[string]Row{"L1": {"sport": "run_outdoor", "avg_hr": int64(150), "distance_m": 10000.0}}
	if ms := Diff(fields(), a, b); len(ms) != 0 {
		t.Errorf("expected no mismatches, got %v", ms)
	}
}

func TestDiff_FloatWithinTolerance(t *testing.T) {
	a := map[string]Row{"L1": {"distance_m": 10000.00}}
	b := map[string]Row{"L1": {"distance_m": 10000.009}} // within 0.011
	if ms := Diff([]Field{{Name: "distance_m", Kind: Float, Tol: 0.011}}, a, b); len(ms) != 0 {
		t.Errorf("within tolerance should match, got %v", ms)
	}
}

func TestDiff_FloatBeyondTolerance(t *testing.T) {
	a := map[string]Row{"L1": {"distance_m": 10000.0}}
	b := map[string]Row{"L1": {"distance_m": 10001.0}}
	ms := Diff([]Field{{Name: "distance_m", Kind: Float, Tol: 0.011}}, a, b)
	if len(ms) != 1 || ms[0].Field != "distance_m" {
		t.Errorf("expected 1 distance_m mismatch, got %v", ms)
	}
}

func TestDiff_ExactMismatch(t *testing.T) {
	a := map[string]Row{"L1": {"sport": "run_outdoor"}}
	b := map[string]Row{"L1": {"sport": "run_trail"}}
	ms := Diff([]Field{{Name: "sport", Kind: Exact}}, a, b)
	if len(ms) != 1 || ms[0].Field != "sport" {
		t.Errorf("expected sport mismatch, got %v", ms)
	}
}

func TestDiff_MissingRow(t *testing.T) {
	a := map[string]Row{"L1": {"sport": "run_outdoor"}, "L2": {"sport": "run_trail"}}
	b := map[string]Row{"L1": {"sport": "run_outdoor"}}
	ms := Diff([]Field{{Name: "sport", Kind: Exact}}, a, b)
	if len(ms) != 1 || ms[0].Key != "L2" || ms[0].Field != "" {
		t.Errorf("expected L2 presence mismatch, got %v", ms)
	}
}

func TestDiff_Nullability(t *testing.T) {
	// nil vs nil is fine; nil vs value is a mismatch.
	both := map[string]Row{"L1": {"avg_hr": nil}}
	if ms := Diff([]Field{{Name: "avg_hr", Kind: Exact}}, both, both); len(ms) != 0 {
		t.Errorf("nil==nil should match, got %v", ms)
	}
	a := map[string]Row{"L1": {"avg_hr": nil}}
	b := map[string]Row{"L1": {"avg_hr": int64(150)}}
	ms := Diff([]Field{{Name: "avg_hr", Kind: Exact}}, a, b)
	if len(ms) != 1 {
		t.Errorf("expected nullability mismatch, got %v", ms)
	}
}
