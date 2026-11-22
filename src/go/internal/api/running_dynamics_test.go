package api

import (
	"encoding/json"
	"net/http"
	"reflect"
	"testing"

	"github.com/zhaochy1990/stride/internal/storage"
)

func TestActivityDetail_RunningDynamicsUsesRawSamples(t *testing.T) {
	store := baseDetailStore()
	store.series = make([]storage.TimeseriesPoint, 2500)
	for i := range store.series {
		store.series[i] = storage.TimeseriesPoint{Timestamp: i64ptr(int64(i) * 10), Cadence: iptr(180)}
	}
	// The existing point series samples even indexes, missing this maximum.
	store.series[101].Cadence = iptr(201)
	h := newActivityHarness(t, store)
	path := "/api/" + activityUserA + "/activities/act-1"
	for _, include := range []string{"timeseries", "running_dynamics", "timeseries,running_dynamics"} {
		w := h.do(http.MethodGet, path+"?include="+include, h.bearer(t, activityUserA))
		if w.Code != http.StatusOK {
			t.Fatalf("%s: %d %s", include, w.Code, w.Body)
		}
		var resp activityDetailResponse
		if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
			t.Fatal(err)
		}
		if include == "timeseries" {
			if resp.RunningDynamics != nil {
				t.Fatal("running_dynamics returned without opt-in")
			}
			continue
		}
		if (resp.Timeseries == nil) != (include == "running_dynamics") {
			t.Fatal("timeseries availability does not match opt-in")
		}
		if resp.RunningDynamics == nil ||
			resp.RunningDynamics.WindowS != 90 || resp.RunningDynamics.Metrics["cadence"].Windows[0].Max != 201 {
			t.Fatalf("missing unsampled cadence maximum: %+v", resp.RunningDynamics)
		}
	}

	store.activity.SportType = 402 // strength
	store.tsCalled = false
	w := h.do(http.MethodGet, path+"?include=running_dynamics", h.bearer(t, activityUserA))
	var resp activityDetailResponse
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil || w.Code != http.StatusOK ||
		resp.RunningDynamics != nil || store.tsCalled {
		t.Fatalf("expected no dynamics read for strength: %d %s", w.Code, w.Body)
	}
}

func TestRunningDynamics_FiltersOnlyIsolatedEdgeSpikes(t *testing.T) {
	data := []struct{ seconds, oscillation, contact int }{
		{0, 0, 0},
		{13, 45, 87}, {14, 90, 175}, {15, 88, 174}, {16, 87, 174},
		{45, 45, 90}, // mid-run extremum is retained
		{90, 80, 180}, {91, 81, 181},
		{176, 91, 185}, {177, 92, 186}, {178, 90, 184},
		{180, 45, 80}, // endpoint belongs to the final full window
	}
	var series []storage.TimeseriesPoint
	for _, row := range data {
		series = append(series, storage.TimeseriesPoint{
			Timestamp: i64ptr(1000000 + int64(row.seconds)*100),
			Cadence:   iptr(row.contact), VerticalOscillationMm: fptr(float64(row.oscillation)),
			GroundContactTimeMs: fptr(float64(row.contact)),
		})
	}
	result := buildRunningDynamics(series, &storage.Activity{Provider: "coros", DurationS: fptr(180)})
	checks := map[string][]runningDynamicsRange{
		"cadence":              {{0, 87, 175}, {1, 80, 186}},
		"vertical_oscillation": {{0, 4.5, 9}, {1, 8, 9.2}},
		"ground_contact_time":  {{0, 90, 175}, {1, 180, 186}},
	}
	for key, want := range checks {
		if got := result.Metrics[key].Windows; !reflect.DeepEqual(got, want) {
			t.Errorf("%s windows = %+v, want %+v", key, got, want)
		}
	}
	if *series[1].VerticalOscillationMm != 45 || *series[len(series)-1].GroundContactTimeMs != 80 {
		t.Fatal("raw samples changed")
	}
}

func TestRunningDynamics_GarminUnitsAndSparseWindows(t *testing.T) {
	p := []storage.TimeseriesPoint{
		{Timestamp: i64ptr(0), Cadence: iptr(85), CadenceLengthCm: fptr(120), VerticalOscillationMm: fptr(8.2)},
		{Timestamp: i64ptr(20000), Cadence: iptr(87), CadenceLengthCm: fptr(125), VerticalOscillationMm: fptr(8.8)},
	}
	activity := &storage.Activity{Provider: "garmin", AvgCadence: iptr(172)}
	result := buildRunningDynamics(p, activity)
	if result.DurationS != 200 || result.Metrics["cadence"].Average != 172 ||
		result.Metrics["vertical_oscillation"].Min != 8.2 || result.Metrics["stride_length"].Max != 1.25 {
		t.Fatalf("unexpected Garmin units: %+v", result.Metrics)
	}
	windows := result.Metrics["cadence"].Windows
	if len(windows) != 2 || windows[0].Index != 0 || windows[1].Index != 2 {
		t.Fatalf("missing window should remain a gap: %+v", windows)
	}
	if _, present := result.Metrics["ground_contact_time"]; present {
		t.Fatal("unrecorded metric should be absent")
	}
}

func TestRunningDynamics_SkipsUnverifiableGarminCadence(t *testing.T) {
	series := []storage.TimeseriesPoint{
		{Timestamp: i64ptr(0), Cadence: iptr(85), CadenceLengthCm: fptr(120)},
		{Timestamp: i64ptr(100), Cadence: iptr(85), CadenceLengthCm: fptr(120)},
		{Timestamp: i64ptr(200), Cadence: iptr(172), CadenceLengthCm: fptr(125)},
	}
	for _, average := range []*int{iptr(172), nil} {
		result := buildRunningDynamics(series, &storage.Activity{Provider: "garmin", AvgCadence: average})
		if _, present := result.Metrics["cadence"]; present {
			t.Fatalf("unverifiable cadence returned: %+v", result.Metrics)
		}
		if len(result.Metrics["stride_length"].Windows) != 1 {
			t.Fatal("stride length should remain available")
		}
	}
}
