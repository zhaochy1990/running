package competitioncalendar

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"go.uber.org/zap"

	"github.com/zhaochy1990/stride/internal/job"
	"github.com/zhaochy1990/stride/internal/storage"
)

func strp(s string) *string { return &s }

// waRow builds a World Athletics row as the mirror stores one.
func waRow(id uint64, date, city, label string, types ...string) storage.RaceCalendarEvent {
	return storage.RaceCalendarEvent{
		ID: id, Source: storage.RaceSourceWorldAth, Country: "CHN",
		Name: "WA race", RaceDate: date, City: strp(city), Label: strp(label),
		RaceTypes: encodeTypes(types),
	}
}

// cnRow builds a 中国田协 row as its mirror stores one.
func cnRow(id uint64, date, city string, types ...string) storage.RaceCalendarEvent {
	return storage.RaceCalendarEvent{
		ID: id, Source: storage.RaceSourceChinaAth, Country: "CHN",
		Name: "2026赛事", RaceDate: date, City: strp(city), Label: strp("A"),
		Origin: storage.RaceOriginSync, RaceTypes: encodeTypes(types),
	}
}

func encodeTypes(types []string) *string {
	if len(types) == 0 {
		return nil
	}
	b, _ := json.Marshal(types)
	return strp(string(b))
}

// nameOf is the label the map holds for an id, and whether the id is present at
// all — the two are different answers and the tests care about both.
func nameOf(m map[uint64]*string, id uint64) (string, bool, bool) {
	v, ok := m[id]
	if !ok {
		return "", false, false
	}
	if v == nil {
		return "", true, true
	}
	return *v, true, false
}

func TestMatchWALabels(t *testing.T) {
	cases := []struct {
		name    string
		scope   storage.RaceCalendarLabelScope
		wantID  uint64
		want    string
		matched int
	}{
		{
			name: "unique candidate copies the tier",
			scope: storage.RaceCalendarLabelScope{
				ChinaAth: []storage.RaceCalendarEvent{cnRow(1, "2026-11-01", "杭州市", "Marathon")},
				WorldAth: []storage.RaceCalendarEvent{waRow(50, "2026-11-01", "杭州市", "Gold", "Marathon")},
			},
			wantID: 1, want: "Gold", matched: 1,
		},
		{
			// WA fills race types only from the GW/GL ranking categories, so most
			// rows say Unknown — that must not block a match.
			name: "unknown WA type still matches",
			scope: storage.RaceCalendarLabelScope{
				ChinaAth: []storage.RaceCalendarEvent{cnRow(1, "2026-10-18", "西安市", "Marathon", "HalfMarathon")},
				WorldAth: []storage.RaceCalendarEvent{waRow(60, "2026-10-18", "西安市", "Label", "Unknown")},
			},
			wantID: 1, want: "Label", matched: 1,
		},
		{
			// The guard against a drifted WA date landing on a different race in
			// the same city: WA says marathon, the 中国田协 row is a half.
			name: "incompatible type is refused",
			scope: storage.RaceCalendarLabelScope{
				ChinaAth: []storage.RaceCalendarEvent{cnRow(1, "2026-05-24", "兰州市", "HalfMarathon")},
				WorldAth: []storage.RaceCalendarEvent{waRow(70, "2026-05-24", "兰州市", "Gold", "Marathon")},
			},
			wantID: 1, matched: 0,
		},
		{
			name: "no candidate leaves the row unlabelled",
			scope: storage.RaceCalendarLabelScope{
				ChinaAth: []storage.RaceCalendarEvent{cnRow(1, "2026-12-06", "上海市")},
				WorldAth: []storage.RaceCalendarEvent{waRow(80, "2026-11-08", "南昌市", "Label")},
			},
			wantID: 1, matched: 0,
		},
		{
			// Two World Athletics listings on one city+date make the pick a coin
			// flip, so neither is used.
			name: "ambiguous candidates are refused",
			scope: storage.RaceCalendarLabelScope{
				ChinaAth: []storage.RaceCalendarEvent{cnRow(1, "2026-10-18", "重庆市")},
				WorldAth: []storage.RaceCalendarEvent{
					waRow(91, "2026-10-18", "重庆市", "Gold", "Unknown"),
					waRow(92, "2026-10-18", "重庆市", "Elite", "Unknown"),
				},
			},
			wantID: 1, matched: 0,
		},
		{
			name: "a row with no city cannot be matched",
			scope: storage.RaceCalendarLabelScope{
				ChinaAth: []storage.RaceCalendarEvent{{ID: 1, RaceDate: "2026-11-01", Origin: storage.RaceOriginSync}},
				WorldAth: []storage.RaceCalendarEvent{waRow(50, "2026-11-01", "杭州市", "Gold")},
			},
			wantID: 1, matched: 0,
		},
		{
			// A matched WA row that itself carries no label is present in the map
			// with a nil value: that is what clears a stale tier.
			name: "matched WA row without a tier yields a nil",
			scope: storage.RaceCalendarLabelScope{
				ChinaAth: []storage.RaceCalendarEvent{cnRow(1, "2026-01-11", "厦门市")},
				WorldAth: []storage.RaceCalendarEvent{{
					ID: 50, RaceDate: "2026-01-11", City: strp("厦门市"),
				}},
			},
			wantID: 1, matched: 1,
		},
		{
			name: "each row matches only its own date",
			scope: storage.RaceCalendarLabelScope{
				ChinaAth: []storage.RaceCalendarEvent{
					cnRow(1, "2026-03-15", "上海市"),
					cnRow(2, "2026-03-22", "无锡市"),
				},
				WorldAth: []storage.RaceCalendarEvent{
					waRow(51, "2026-03-15", "上海市", "Gold"),
					waRow(52, "2026-03-22", "无锡市", "Gold"),
				},
			},
			wantID: 1, want: "Gold", matched: 2,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, matched := matchWALabels(tc.scope)
			if matched != tc.matched {
				t.Fatalf("matched = %d, want %d", matched, tc.matched)
			}
			label, present, isNil := nameOf(got, tc.wantID)
			if tc.matched == 0 {
				if present {
					t.Fatalf("id %d present with %q, want absent", tc.wantID, label)
				}
				return
			}
			if !present {
				t.Fatalf("id %d absent, want present", tc.wantID)
			}
			if tc.want == "" {
				if !isNil {
					t.Fatalf("id %d = %q, want nil", tc.wantID, label)
				}
				return
			}
			if isNil || label != tc.want {
				t.Fatalf("id %d = %v, want %q", tc.wantID, got[tc.wantID], tc.want)
			}
		})
	}
}

// TestTypesCompatible pins the refute-only contract: the check exists to catch a
// wrong pair, so it must never reject a pair merely because WA has no opinion.
func TestTypesCompatible(t *testing.T) {
	cn := encodeTypes([]string{"Marathon", "HalfMarathon"})
	cases := []struct {
		name string
		wa   *string
		want bool
	}{
		{"nil WA types have no opinion", nil, true},
		{"Unknown has no opinion", encodeTypes([]string{"Unknown"}), true},
		{"Other has no opinion", encodeTypes([]string{"Other"}), true},
		{"present type confirms", encodeTypes([]string{"Marathon"}), true},
		{"absent type refutes", encodeTypes([]string{"10Km"}), false},
		{"mixed refutes on the concrete one", encodeTypes([]string{"Unknown", "10Km"}), false},
		{"malformed decodes to no opinion", strp("{not json"), true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := typesCompatible(tc.wa, cn); got != tc.want {
				t.Fatalf("typesCompatible = %v, want %v", got, tc.want)
			}
		})
	}
}

// --- handler ------------------------------------------------------------------

type fakeLabelStore struct {
	scope    storage.RaceCalendarLabelScope
	applied  []storage.RaceCalendarWALabel
	applyErr error
}

func (f *fakeLabelStore) LoadRaceCalendarLabelScope(_ context.Context, _ string) (storage.RaceCalendarLabelScope, error) {
	return f.scope, nil
}

func (f *fakeLabelStore) ApplyRaceCalendarWALabels(_ context.Context, labels []storage.RaceCalendarWALabel) (int, error) {
	if f.applyErr != nil {
		return 0, f.applyErr
	}
	f.applied = append(f.applied, labels...)
	return len(labels), nil
}

func runLabel(t *testing.T, store WALabelStore, input string) string {
	t.Helper()
	h := NewWALabel(WALabelConfig{Store: store, DefaultYears: []string{"2026"}, Logger: zap.NewNop()})
	out, err := h(context.Background(), &job.Job{ID: "j1", InputJSON: input}, func(string, int) error { return nil })
	if err != nil {
		t.Fatalf("handler: %v", err)
	}
	return out
}

// The step must write only real changes: a second run over unchanged data has to
// be a no-op, or every night rewrites every labelled row.
func TestWALabelHandler_WritesOnlyChanges(t *testing.T) {
	existing := cnRow(1, "2026-11-01", "杭州市")
	existing.WALabel = strp("Gold") // already correct
	stale := cnRow(2, "2026-10-18", "西安市")
	stale.WALabel = strp("Elite")          // WA dropped it to Label
	fresh := cnRow(3, "2026-03-15", "上海市") // no tier yet
	never := cnRow(4, "2026-12-06", "上海市") // no counterpart at all

	store := &fakeLabelStore{scope: storage.RaceCalendarLabelScope{
		ChinaAth: []storage.RaceCalendarEvent{existing, stale, fresh, never},
		WorldAth: []storage.RaceCalendarEvent{
			waRow(51, "2026-11-01", "杭州市", "Gold"),
			waRow(52, "2026-10-18", "西安市", "Label"),
			waRow(53, "2026-03-15", "上海市", "Gold"),
		},
	}}

	out := runLabel(t, store, `{"years":["2026"]}`)

	if len(store.applied) != 2 {
		t.Fatalf("applied %d rows (%+v), want 2 (the stale and the fresh)", len(store.applied), store.applied)
	}
	byID := map[uint64]*string{}
	for _, l := range store.applied {
		byID[l.ID] = l.WALabel
	}
	if v := byID[2]; v == nil || *v != "Label" {
		t.Errorf("row 2 = %v, want Label (the tier changed)", byID[2])
	}
	if v := byID[3]; v == nil || *v != "Gold" {
		t.Errorf("row 3 = %v, want Gold", byID[3])
	}
	if _, touched := byID[1]; touched {
		t.Errorf("row 1 rewritten though its tier was already Gold")
	}
	if _, touched := byID[4]; touched {
		t.Errorf("row 4 written though it has no counterpart and no tier")
	}

	var got struct {
		Years map[string]waLabelYearSummary `json:"years"`
	}
	if err := json.Unmarshal([]byte(out), &got); err != nil {
		t.Fatalf("result is not JSON: %v (%s)", err, out)
	}
	if s := got.Years["2026"]; s.Labeled != 2 || s.Unmerged != 1 {
		t.Fatalf("summary = %+v, want labeled 2 unmerged 1", s)
	}
}

// Clearing matters as much as setting: a race that loses its World Athletics
// listing must not keep a tier the upstream no longer awards.
func TestWALabelHandler_ClearsLostTier(t *testing.T) {
	was := cnRow(1, "2026-11-01", "杭州市")
	was.WALabel = strp("Gold")

	store := &fakeLabelStore{scope: storage.RaceCalendarLabelScope{
		ChinaAth: []storage.RaceCalendarEvent{was},
		WorldAth: nil, // the listing is gone
	}}

	out := runLabel(t, store, `{"years":["2026"]}`)

	if len(store.applied) != 1 {
		t.Fatalf("applied %d rows, want 1 clear", len(store.applied))
	}
	if got := store.applied[0]; got.ID != 1 || got.WALabel != nil {
		t.Fatalf("applied = %+v, want row 1 cleared", got)
	}
	var parsed struct {
		Years map[string]waLabelYearSummary `json:"years"`
	}
	_ = json.Unmarshal([]byte(out), &parsed)
	if parsed.Years["2026"].Cleared != 1 {
		t.Fatalf("summary = %+v, want cleared 1", parsed.Years["2026"])
	}
}

func TestWALabelHandler_MalformedInputIsPermanent(t *testing.T) {
	h := NewWALabel(WALabelConfig{Store: &fakeLabelStore{}, Logger: zap.NewNop()})
	_, err := h(context.Background(), &job.Job{ID: "j1", InputJSON: "{not json"}, func(string, int) error { return nil })
	var perm *job.PermanentError
	if !errors.As(err, &perm) {
		t.Fatalf("err = %v, want a permanent error (a retry cannot fix bad JSON)", err)
	}
}

func TestWALabelHandler_WriteErrorPropagates(t *testing.T) {
	boom := errors.New("db down")
	st := &fakeLabelStore{
		scope: storage.RaceCalendarLabelScope{
			ChinaAth: []storage.RaceCalendarEvent{cnRow(1, "2026-11-01", "杭州市")},
			WorldAth: []storage.RaceCalendarEvent{waRow(51, "2026-11-01", "杭州市", "Gold")},
		},
		applyErr: boom,
	}
	h := NewWALabel(WALabelConfig{Store: st, DefaultYears: []string{"2026"}, Logger: zap.NewNop()})
	if _, err := h(context.Background(), &job.Job{ID: "j1"}, func(string, int) error { return nil }); !errors.Is(err, boom) {
		t.Fatalf("err = %v, want the store error", err)
	}
}
