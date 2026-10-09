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
// be a no-op, or every night rewrites every mirrored row. Since devops#443 the
// job is the self-mirror only — 中国田协 rows are the mirror dedup's business and
// must not be touched, or the job would erase the tiers that dedup just wrote.
func TestWALabelHandler_WritesOnlyChanges(t *testing.T) {
	cnStale := cnRow(1, "2026-10-18", "西安市")
	cnStale.WALabel = strp("Elite") // the mirror dedup's business, not this job's
	cnNever := cnRow(2, "2026-12-06", "上海市")

	waGold := waRow(51, "2026-11-01", "杭州市", "Gold")
	waGold.WALabel = strp("Gold") // its own row already mirrors its tier
	waLabel := waRow(52, "2026-10-18", "西安市", "Label")
	waFresh := waRow(53, "2026-03-15", "上海市", "Gold")

	store := &fakeLabelStore{scope: storage.RaceCalendarLabelScope{
		ChinaAth: []storage.RaceCalendarEvent{cnStale, cnNever},
		WorldAth: []storage.RaceCalendarEvent{waGold, waLabel, waFresh},
	}}

	out := runLabel(t, store, `{"years":["2026"]}`)

	// The two World Athletics rows that had no wa_label yet; withheld: WA row 51
	// (already correct) and BOTH 中国田协 rows.
	if len(store.applied) != 2 {
		t.Fatalf("applied %d rows (%+v), want 2", len(store.applied), store.applied)
	}
	byID := map[uint64]*string{}
	for _, l := range store.applied {
		byID[l.ID] = l.WALabel
	}
	if v := byID[52]; v == nil || *v != "Label" {
		t.Errorf("WA row 52 = %v, want its own Label mirrored", byID[52])
	}
	if v := byID[53]; v == nil || *v != "Gold" {
		t.Errorf("WA row 53 = %v, want its own Gold mirrored", byID[53])
	}
	if _, touched := byID[51]; touched {
		t.Errorf("WA row 51 rewritten though its wa_label already held its tier")
	}
	for _, id := range []uint64{1, 2} {
		if _, touched := byID[id]; touched {
			t.Errorf("中国田协 row %d written — the mirror dedup owns that side", id)
		}
	}

	var got struct {
		Years map[string]waLabelYearSummary `json:"years"`
	}
	if err := json.Unmarshal([]byte(out), &got); err != nil {
		t.Fatalf("result is not JSON: %v (%s)", err, out)
	}
	if s := got.Years["2026"]; s.Mirrored != 2 || s.Labeled != 0 || s.Unmatched != 0 || s.Cleared != 0 {
		t.Fatalf("summary = %+v, want mirrored 2 and the copy counts at zero", s)
	}
}

// The job stopped reconciling 中国田协 rows when the copy moved into the mirror's
// dedup (devops#443): a tier the dedup wrote must survive this step, even though
// the row's counterpart no longer exists as a 国际田联 row.
func TestWALabelHandler_LeavesChineseRowsToTheMirror(t *testing.T) {
	was := cnRow(1, "2026-11-01", "杭州市")
	was.WALabel = strp("Gold") // written by the mirror dedup; its WA row is gone

	store := &fakeLabelStore{scope: storage.RaceCalendarLabelScope{
		ChinaAth: []storage.RaceCalendarEvent{was},
		WorldAth: nil, // the dedup means no 国际田联 row exists for a matched race
	}}

	out := runLabel(t, store, `{"years":["2026"]}`)

	if len(store.applied) != 0 {
		t.Fatalf("applied %+v, want nothing — the mirror dedup owns 中国田协 rows", store.applied)
	}
	var parsed struct {
		Years map[string]waLabelYearSummary `json:"years"`
	}
	_ = json.Unmarshal([]byte(out), &parsed)
	if s := parsed.Years["2026"]; s.Labeled != 0 || s.Cleared != 0 || s.Mirrored != 0 {
		t.Fatalf("summary = %+v, want all zeros", s)
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
