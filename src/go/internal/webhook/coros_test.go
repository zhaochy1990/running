package webhook

import (
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"testing"
	"time"
)

// corosDocFixture is the 5.3.3 input-example push body verbatim from the COROS
// API Reference (V2.1.1): a triathlon parent (mode 13 — no top-level fitUrl,
// FIT urls on the three triathlonItemList children), an outdoor run, a bike
// ride and a second run. Kept byte-shape-faithful so parsing regressions
// against the real payload surface here, not on a live push.
const corosDocFixture = `{
    "sportDataList":[
        {
            "avgFrequency":0,
            "avgSpeed":0,
            "calorie":220000,
            "deviceName":"COROS PACE",
            "distance":22000,
            "duration":2200,
            "endTime":1532576178,
            "endTimezone":32,
            "labelId":"418173292602490880",
            "openId": "42dbb958c5a146f29ce9f89e05e5195a",
            "mode":13,
            "subMode":1,
            "startTime":1522576178,
            "startTimezone":32,
            "step":2200,
            "triathlonItemList":[
                {
                    "calorie":117738,
                    "distance":748.07,
                    "duration":901,
                    "fitUrl":"https://oss.coros.com/fit/407419767966679040/418173292602490880_0.fit",
                    "mode":10,
                    "subMode":1
                },
                {
                    "calorie":391220,
                    "distance":19911.3,
                    "duration":2761,
                    "fitUrl":"https://oss.coros.com/fit/407419767966679040/418173292602490880_1.fit",
                    "mode":9,
                    "subMode":1
                },
                {
                    "calorie":248338,
                    "distance":5142.43,
                    "duration":1592,
                    "fitUrl":"https://oss.coros.com/fit/407419767966679040/418173292602490880_2.fit",
                    "mode":8,
                    "subMode":1
                }
            ]
        },
        {
            "avgFrequency":0,
            "avgSpeed":368,
            "calorie":30000,
            "deviceName":"COROS PACE",
            "distance":40000,
            "duration":300,
            "endTime":1532576159,
            "endTimezone":32,
            "fitUrl":"https://oss.coros.com/fit/407419767966679040/418173315956375553.fit",
            "labelId":"418173315956375553",
            "openId": "42dbb958c5a146f29ce9f89e05e5195a",
            "mode":8,
            "startTime":1522576159,
            "startTimezone":32,
            "step":300,
            "subMode":1
        },
        {
            "avgFrequency":0,
            "avgSpeed":0,
            "calorie":20000,
            "deviceName":"COROS PACE",
            "distance":20000,
            "duration":200,
            "endTime":1532576158,
            "endTimezone":32,
            "fitUrl":"https://oss.coros.com/fit/407419767966679040/418173315956375552.fit",
            "labelId":"418173315956375552",
            "openId": "42dbb958c5a146f29ce9f89e05e5195a",
            "mode":9,
            "startTime":1522576158,
            "startTimezone":32,
            "step":200,
            "subMode":1
        },
        {
            "avgFrequency":199,
            "avgSpeed":368,
            "calorie":10000,
            "deviceName":"COROS PACE",
            "distance":10000,
            "duration":100,
            "endTime":1532576157,
            "endTimezone":32,
            "fitUrl":"https://oss.coros.com/fit/407419767966679040/418173292602490881.fit",
            "labelId":"418173292602490881",
            "openId": "42dbb958c5a146f29ce9f89e05e5195a",
            "mode":8,
            "startTime":1522576157,
            "startTimezone":32,
            "step":100,
            "subMode":1
        }
    ]
}`

func TestCorosAdapter_Provider(t *testing.T) {
	if got := NewCorosAdapter("c", "s").Provider(); got != "coros" {
		t.Fatalf("Provider() = %q, want coros", got)
	}
}

func TestCorosAdapter_VerifyCredentials(t *testing.T) {
	adapter := NewCorosAdapter("stride-client", "stride-secret")
	ok := func(h http.Header) bool { return adapter.VerifyCredentials(h) == nil }

	cases := []struct {
		name   string
		header http.Header
		want   bool
	}{
		{"matching pair", http.Header{"Client": {"stride-client"}, "Secret": {"stride-secret"}}, true},
		{"missing client", http.Header{"Secret": {"stride-secret"}}, false},
		{"missing secret", http.Header{"Client": {"stride-client"}}, false},
		{"wrong client", http.Header{"Client": {"other"}, "Secret": {"stride-secret"}}, false},
		{"wrong secret", http.Header{"Client": {"stride-client"}, "Secret": {"other"}}, false},
		{"empty headers", http.Header{}, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := ok(tc.header); got != tc.want {
				t.Fatalf("VerifyCredentials() accepted = %v, want %v", got, tc.want)
			}
		})
	}
	// An adapter wired without credentials must never verify.
	if NewCorosAdapter("", "").VerifyCredentials(http.Header{"Client": {""}, "Secret": {""}}) == nil {
		t.Fatal("empty configured credentials must not verify")
	}
}

func TestCorosAdapter_ParseEvents_DocFixture(t *testing.T) {
	adapter := NewCorosAdapter("c", "s")
	events, err := adapter.ParseEvents([]byte(corosDocFixture))
	if err != nil {
		t.Fatalf("ParseEvents(doc fixture): %v", err)
	}
	if len(events) != 4 {
		t.Fatalf("got %d events, want 4", len(events))
	}

	tri := events[0]
	if tri.ProviderActivityID != "418173292602490880" || tri.ProviderUserID != "42dbb958c5a146f29ce9f89e05e5195a" {
		t.Fatalf("triathlon identity = %q/%q", tri.ProviderUserID, tri.ProviderActivityID)
	}
	if tri.EventType != EventTypeActivityCreate {
		t.Fatalf("event_type = %q, want %q", tri.EventType, EventTypeActivityCreate)
	}
	// Multisport parent (mode 13): no top-level fitUrl — must parse fine and
	// stay empty, not rejected.
	if tri.FitURL != "" {
		t.Fatalf("triathlon fit_url = %q, want empty (children carry the FIT urls)", tri.FitURL)
	}
	wantEnd := time.Unix(1532576178, 0).UTC()
	if !tri.OccurTime.Equal(wantEnd) {
		t.Fatalf("occur_time = %v, want %v (endTime, UTC)", tri.OccurTime, wantEnd)
	}
	// The triathlon children must survive verbatim in the summary fragment.
	var frag struct {
		Children []json.RawMessage `json:"triathlonItemList"`
	}
	if err := json.Unmarshal(tri.SummaryJSON, &frag); err != nil {
		t.Fatalf("summary fragment not valid JSON: %v", err)
	}
	if len(frag.Children) != 3 {
		t.Fatalf("triathlonItemList children = %d, want 3", len(frag.Children))
	}
	var child struct {
		FitURL string `json:"fitUrl"`
	}
	if err := json.Unmarshal(frag.Children[0], &child); err != nil {
		t.Fatalf("child decode: %v", err)
	}
	if !strings.HasPrefix(child.FitURL, "https://oss.coros.com/fit/") {
		t.Fatalf("child fitUrl = %q, want the oss.coros.com download url", child.FitURL)
	}

	// Regular item keeps its top-level fitUrl and optional planWorkoutId is
	// empty (absent in every doc example).
	run := events[1]
	if run.FitURL != "https://oss.coros.com/fit/407419767966679040/418173315956375553.fit" {
		t.Fatalf("run fit_url = %q", run.FitURL)
	}
	if run.PlanWorkoutID != "" {
		t.Fatalf("plan_workout_id = %q, want empty when absent", run.PlanWorkoutID)
	}
}

// corosItem is a minimal valid non-multisport item for the validation tests.
func corosItem(overrides string) string {
	base := `{
		"openId":"openid-1","labelId":"label-1","mode":8,"subMode":1,
		"distance":10000,"calorie":600,"avgSpeed":360,"avgFrequency":180,
		"startTime":1700000000,"endTime":1700003600,
		"startTimezone":32,"endTimezone":32,
		"fitUrl":"https://oss.coros.com/fit/x.fit","planWorkoutId":"42"
	}`
	if overrides == "" {
		return base
	}
	var m map[string]any
	if err := json.Unmarshal([]byte(base), &m); err != nil {
		panic(err)
	}
	if err := json.Unmarshal([]byte(overrides), &m); err != nil {
		panic(err)
	}
	out, _ := json.Marshal(m)
	return string(out)
}

func TestCorosAdapter_ParseEvents_PlanWorkoutIDAndDurationOptional(t *testing.T) {
	adapter := NewCorosAdapter("c", "s")
	body := `{"sportDataList":[` + corosItem(`{"planWorkoutId":null,"duration":null}`) + `]}`
	events, err := adapter.ParseEvents([]byte(body))
	if err != nil {
		t.Fatalf("ParseEvents: %v", err)
	}
	if events[0].PlanWorkoutID != "" {
		t.Fatalf("plan_workout_id = %q, want empty", events[0].PlanWorkoutID)
	}
}

func TestCorosAdapter_ParseEvents_RequiredFields(t *testing.T) {
	adapter := NewCorosAdapter("c", "s")
	// Every field the 5.3.3 parameter table marks Required, plus the shape
	// errors. duration is deliberately absent from the removal list: the
	// table omits it, so a push without it must not be rejected.
	cases := []struct {
		name string
		body string
	}{
		{"not json", `not json`},
		{"no sportDataList", `{"foo":1}`},
		{"item not object", `{"sportDataList":[3]}`},
		{"empty openId", `{"sportDataList":[` + corosItem(`{"openId":null}`) + `]}`},
		{"missing labelId", `{"sportDataList":[` + corosItem(`{"labelId":null}`) + `]}`},
		{"missing mode", `{"sportDataList":[` + corosItem(`{"mode":null}`) + `]}`},
		{"missing subMode", `{"sportDataList":[` + corosItem(`{"subMode":null}`) + `]}`},
		{"missing distance", `{"sportDataList":[` + corosItem(`{"distance":null}`) + `]}`},
		{"missing calorie", `{"sportDataList":[` + corosItem(`{"calorie":null}`) + `]}`},
		{"missing avgSpeed", `{"sportDataList":[` + corosItem(`{"avgSpeed":null}`) + `]}`},
		{"missing avgFrequency", `{"sportDataList":[` + corosItem(`{"avgFrequency":null}`) + `]}`},
		{"missing startTime", `{"sportDataList":[` + corosItem(`{"startTime":null}`) + `]}`},
		{"missing endTime", `{"sportDataList":[` + corosItem(`{"endTime":null}`) + `]}`},
		{"missing startTimezone", `{"sportDataList":[` + corosItem(`{"startTimezone":null}`) + `]}`},
		{"missing endTimezone", `{"sportDataList":[` + corosItem(`{"endTimezone":null}`) + `]}`},
		{"missing fitUrl on run", `{"sportDataList":[` + corosItem(`{"fitUrl":null}`) + `]}`},
		// One invalid item rejects the whole batch (the provider re-pushes
		// batches atomically).
		{"one bad item in batch", `{"sportDataList":[` + corosItem("") + `,` + corosItem(`{"labelId":null}`) + `]}`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := adapter.ParseEvents([]byte(tc.body)); err == nil {
				t.Fatal("ParseEvents accepted an invalid push")
			}
		})
	}
}

func TestCorosAdapter_ParseEvents_MultisportModesSkipTopFitURL(t *testing.T) {
	adapter := NewCorosAdapter("c", "s")
	// mode 13 (triathlon/multisport/ski-touring/outdoor-climb parents) and 14
	// (mountain climb) push no top-level fitUrl — table rule, not a doc typo.
	for _, mode := range []int{13, 14} {
		body := `{"sportDataList":[` + corosItem(`{"mode":`+strconv.Itoa(mode)+`,"fitUrl":null}`) + `]}`
		if _, err := adapter.ParseEvents([]byte(body)); err != nil {
			t.Fatalf("mode %d without top-level fitUrl rejected: %v", mode, err)
		}
	}
}

func TestCorosAdapter_ParseEvents_EmptyBatchIsValid(t *testing.T) {
	// An empty (but present) sportDataList is a well-formed no-op push.
	if events, err := NewCorosAdapter("c", "s").ParseEvents([]byte(`{"sportDataList":[]}`)); err != nil || len(events) != 0 {
		t.Fatalf("empty sportDataList: events=%v err=%v, want 0 events and no error", events, err)
	}
}
