package competitioncalendar

import (
	"encoding/json"
	"testing"

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

// detachedWARow is a 国际田联 row an administrator took over — any admin edit
// flips the whole row to origin=manual. Since devops#533 it stays in the dedup
// scope, so its listing merges into it instead of re-inserting the twin. The
// tier write it plans is blocked by the store's origin guard (the admin owns
// the tier on a detached row); here the matcher's decision is what's pinned.
func detachedWARow(id uint64, date, city, label string, types ...string) storage.RaceCalendarEvent {
	row := waRow(id, date, city, label, types...)
	row.Origin = storage.RaceOriginManual
	return row
}

// named replaces a row's upstream name — the T2 cases need real listing names,
// the distance guard derives from them.
func named(row storage.RaceCalendarEvent, name string) storage.RaceCalendarEvent {
	row.Name = name
	return row
}

// namesOf extracts the kept rows' names in order — the assertions care about
// which listings survive and in what order they reach the mirror write.
func namesOf(rows []storage.RaceCalendarEvent) []string {
	out := make([]string, 0, len(rows))
	for _, r := range rows {
		out = append(out, r.Name)
	}
	return out
}

func labelsOf(labels []storage.RaceCalendarWALabel) map[uint64]*string {
	m := make(map[uint64]*string, len(labels))
	for _, l := range labels {
		m[l.ID] = l.WALabel
	}
	return m
}

// cnRowWithLabel is a 中国田协 row that already carries a tier — the state after
// a mirror run stamped it, and the state the reconcile half must maintain.
func cnRowWithLabel(id uint64, date, city, label string, types ...string) storage.RaceCalendarEvent {
	cn := cnRow(id, date, city, types...)
	cn.WALabel = strp(label)
	return cn
}

func TestPlanMirrorDedup(t *testing.T) {
	cases := []struct {
		name       string
		upstream   []storage.RaceCalendarEvent
		candidates []storage.RaceCalendarEvent
		wantKeep   []string
		wantLabels map[uint64]string // "" means a nil (clear) entry
		want       mirrorDedupSummary
	}{
		{
			name: "unique pair merges: listing dropped, tier stamped",
			upstream: []storage.RaceCalendarEvent{
				waRow(50, "2026-10-18", "西安市", "Gold", "Unknown"),
			},
			candidates: []storage.RaceCalendarEvent{
				cnRow(1, "2026-10-18", "西安市", "Marathon", "HalfMarathon"),
			},
			wantKeep:   []string{},
			wantLabels: map[uint64]string{1: "Gold"},
			want:       mirrorDedupSummary{Deduped: 1, Stamped: 1},
		},
		{
			name: "unknown WA type still merges",
			upstream: []storage.RaceCalendarEvent{
				waRow(50, "2026-10-18", "西安市", "Label", "Unknown"),
			},
			candidates: []storage.RaceCalendarEvent{
				cnRow(1, "2026-10-18", "西安市", "Marathon", "HalfMarathon"),
			},
			wantKeep:   []string{},
			wantLabels: map[uint64]string{1: "Label"},
			want:       mirrorDedupSummary{Deduped: 1, Stamped: 1},
		},
		{
			name: "contradicting types keep the listing and clear the stale tier",
			upstream: []storage.RaceCalendarEvent{
				waRow(50, "2026-05-24", "兰州市", "Gold", "Marathon"),
			},
			candidates: []storage.RaceCalendarEvent{
				cnRowWithLabel(1, "2026-05-24", "兰州市", "Gold", "HalfMarathon"),
			},
			wantKeep:   []string{"WA race"},
			wantLabels: map[uint64]string{1: ""},
			want:       mirrorDedupSummary{TypeRefused: 1, Cleared: 1},
		},
		{
			name: "no Chinese row: the listing is the race (北京马拉松)",
			upstream: []storage.RaceCalendarEvent{
				waRow(50, "2026-11-08", "北京市", "Gold", "Marathon"),
			},
			candidates: []storage.RaceCalendarEvent{
				cnRow(1, "2026-11-01", "杭州市", "Marathon"),
			},
			wantKeep: []string{"WA race"},
			want:     mirrorDedupSummary{},
		},
		{
			name: "two Chinese rows on one key refuse the merge",
			upstream: []storage.RaceCalendarEvent{
				waRow(50, "2026-10-18", "重庆市", "Gold", "Unknown"),
			},
			candidates: []storage.RaceCalendarEvent{
				cnRowWithLabel(1, "2026-10-18", "重庆市", "Gold", "Marathon"),
				cnRowWithLabel(2, "2026-10-18", "重庆市", "Elite", "HalfMarathon"),
			},
			wantKeep:   []string{"WA race"},
			wantLabels: map[uint64]string{1: "", 2: ""},
			want:       mirrorDedupSummary{Ambiguous: 1, Cleared: 2},
		},
		{
			name: "two listings on one key refuse the merge (一对多)",
			upstream: []storage.RaceCalendarEvent{
				waRow(50, "2026-10-18", "重庆市", "Gold", "Unknown"),
				waRow(51, "2026-10-18", "重庆市", "Elite", "Unknown"),
			},
			candidates: []storage.RaceCalendarEvent{
				cnRowWithLabel(1, "2026-10-18", "重庆市", "Gold", "Marathon"),
			},
			wantKeep:   []string{"WA race", "WA race"},
			wantLabels: map[uint64]string{1: ""},
			want:       mirrorDedupSummary{Ambiguous: 2, Cleared: 1},
		},
		{
			name: "a foreign listing never merges",
			upstream: []storage.RaceCalendarEvent{
				waRowUSA(50, "2026-04-20", "Boston", "Platinum"),
			},
			candidates: []storage.RaceCalendarEvent{
				cnRow(1, "2026-04-20", "Boston", "Marathon"),
			},
			wantKeep: []string{"WA race"},
			want:     mirrorDedupSummary{},
		},
		{
			name: "a listing without a parsed city cannot merge",
			upstream: []storage.RaceCalendarEvent{
				noCityRow(50, "2026-11-01", "Gold"),
			},
			candidates: []storage.RaceCalendarEvent{
				cnRow(1, "2026-11-01", "杭州市", "Marathon"),
			},
			wantKeep: []string{"NoCity race"},
			want:     mirrorDedupSummary{},
		},
		{
			name: "matched listing without a tier clears a stale one",
			upstream: []storage.RaceCalendarEvent{
				noLabelRow(50, "2026-01-11", "厦门市", "Unknown"),
			},
			candidates: []storage.RaceCalendarEvent{
				cnRowWithLabel(1, "2026-01-11", "厦门市", "Gold", "Marathon"),
			},
			wantKeep:   []string{},
			wantLabels: map[uint64]string{1: ""},
			want:       mirrorDedupSummary{Deduped: 1, Cleared: 1},
		},
		{
			name: "a tier no listing supports is reconciled away",
			upstream: []storage.RaceCalendarEvent{
				waRow(50, "2026-11-01", "杭州市", "Gold", "Unknown"),
			},
			candidates: []storage.RaceCalendarEvent{
				cnRowWithLabel(1, "2026-11-01", "杭州市", "Gold", "Marathon"),     // covered, no write
				cnRowWithLabel(2, "2026-12-06", "上海市", "Platinum", "Marathon"), // listing gone
			},
			wantKeep:   []string{},
			wantLabels: map[uint64]string{2: ""},
			want:       mirrorDedupSummary{Deduped: 1, Cleared: 1},
		},
		{
			name: "kept and deduped listings preserve input order",
			upstream: []storage.RaceCalendarEvent{
				waRow(50, "2026-11-08", "北京市", "Gold", "Marathon"), // no Chinese row
				waRow(51, "2026-10-18", "西安市", "Label", "Unknown"), // merges
				waRow(52, "2026-12-06", "上海市", "Platinum", "Unknown"),
			},
			candidates: []storage.RaceCalendarEvent{
				cnRow(1, "2026-12-06", "上海市", "Marathon"),
			},
			wantKeep:   []string{"WA race", "WA race"},
			wantLabels: map[uint64]string{1: "Platinum"},
			want:       mirrorDedupSummary{Deduped: 1, Stamped: 1},
		},
		{
			// devops#533 root cause 1: the admin took the WA row over (renamed
			// it 上马), the old source-list scope lost it, and the next sync
			// re-inserted the English-name twin beside it.
			name: "a detached WA row joins the match set: the listing merges, no twin",
			upstream: []storage.RaceCalendarEvent{
				named(waRow(50, "2026-11-30", "上海市", "Platinum", "Unknown"), "Shanghai Marathon"),
			},
			candidates: []storage.RaceCalendarEvent{
				detachedWARow(14962, "2026-11-30", "上海市", "", "Unknown"),
			},
			wantKeep:   []string{},
			wantLabels: map[uint64]string{14962: "Platinum"},
			want:       mirrorDedupSummary{Deduped: 1, Stamped: 1},
		},
		{
			// devops#533 root cause 2: the stored WA row spells the city in
			// English, the 中国田协 row in Chinese — normalize at match time.
			name: "English city normalizes onto the Chinese row (Hefei ↔ 合肥市)",
			upstream: []storage.RaceCalendarEvent{
				named(waRow(50, "2026-04-12", "Hefei", "Label", "Unknown"), "Hefei Marathon"),
			},
			candidates: []storage.RaceCalendarEvent{
				cnRow(1, "2026-04-12", "合肥市", "Marathon"),
			},
			wantKeep:   []string{},
			wantLabels: map[uint64]string{1: "Label"},
			want:       mirrorDedupSummary{Deduped: 1, Stamped: 1},
		},
		{
			// devops#533 root cause 3, the 南昌 pair: WA still lists 11-08, the
			// organiser's (and 中国田协's) date is 11-15. T2 merges across the
			// drift: the listing is dropped, the tier lands.
			name: "南昌式 7 天漂移 T2 命中",
			upstream: []storage.RaceCalendarEvent{
				named(waRow(50, "2026-11-08", "南昌市", "Label", "Unknown"), "Nanchang Marathon"),
			},
			candidates: []storage.RaceCalendarEvent{
				cnRow(597, "2026-11-15", "南昌市", "Unknown"),
			},
			wantKeep:   []string{},
			wantLabels: map[uint64]string{597: "Label"},
			want:       mirrorDedupSummary{Deduped: 1, Drifted: 1, Stamped: 1},
		},
		{
			name: "T2 drift merge with a matching derived half-marathon distance",
			upstream: []storage.RaceCalendarEvent{
				named(waRow(50, "2026-11-08", "常州市", "Elite", "Unknown"), "Changzhou West Taihu Half Marathon"),
			},
			candidates: []storage.RaceCalendarEvent{
				cnRow(583, "2026-11-14", "常州市", "HalfMarathon"),
			},
			wantKeep:   []string{},
			wantLabels: map[uint64]string{583: "Elite"},
			want:       mirrorDedupSummary{Deduped: 1, Drifted: 1, Stamped: 1},
		},
		{
			// The T2 guard's whole point: a city can run a half marathon half a
			// month beside its marathon; a marathon listing must not stamp it.
			name: "同城半月：marathon listing refuses the half-marathon row",
			upstream: []storage.RaceCalendarEvent{
				named(waRow(50, "2026-11-08", "上海市", "Platinum", "Unknown"), "Shanghai Marathon"),
			},
			candidates: []storage.RaceCalendarEvent{
				cnRow(1, "2026-11-15", "上海市", "HalfMarathon"),
			},
			wantKeep:   []string{"Shanghai Marathon"},
			wantLabels: map[uint64]string{},
			want:       mirrorDedupSummary{TypeRefused: 1},
		},
		{
			name: "T2 refuses when the listing's name derives no distance",
			upstream: []storage.RaceCalendarEvent{
				named(waRow(50, "2026-11-08", "南昌市", "Label", "Unknown"), "Nanchang Grand Running Festival"),
			},
			candidates: []storage.RaceCalendarEvent{
				cnRow(597, "2026-11-15", "南昌市", "Unknown"),
			},
			wantKeep:   []string{"Nanchang Grand Running Festival"},
			wantLabels: map[uint64]string{},
			want:       mirrorDedupSummary{TypeRefused: 1},
		},
		{
			name: "T2 refuses when two Chinese rows sit in the window (row side ambiguous)",
			upstream: []storage.RaceCalendarEvent{
				named(waRow(50, "2026-11-08", "南昌市", "Label", "Unknown"), "Nanchang Marathon"),
			},
			candidates: []storage.RaceCalendarEvent{
				cnRow(597, "2026-11-15", "南昌市", "Unknown"),
				cnRow(598, "2026-11-20", "南昌市", "Unknown"),
			},
			wantKeep:   []string{"Nanchang Marathon"},
			wantLabels: map[uint64]string{},
			want:       mirrorDedupSummary{Ambiguous: 1},
		},
		{
			name: "T2 refuses when two listings sit near one Chinese row (listing side ambiguous)",
			upstream: []storage.RaceCalendarEvent{
				named(waRow(50, "2026-11-08", "南昌市", "Label", "Unknown"), "Nanchang Marathon"),
				named(waRow(51, "2026-11-22", "南昌市", "Gold", "Unknown"), "Nanchang Riverside Half Marathon"),
			},
			candidates: []storage.RaceCalendarEvent{
				cnRow(597, "2026-11-15", "南昌市", "Unknown"),
			},
			wantKeep:   []string{"Nanchang Marathon", "Nanchang Riverside Half Marathon"},
			wantLabels: map[uint64]string{},
			want:       mirrorDedupSummary{Ambiguous: 2},
		},
		{
			// Exactly the 上马 drift pair, matched: the tier survives the drift,
			// the 30d tier guard passes on the derived distance.
			name: "T2 respects the window edge (31 days refuses)",
			upstream: []storage.RaceCalendarEvent{
				named(waRow(50, "2026-10-15", "南昌市", "Label", "Unknown"), "Nanchang Marathon"),
			},
			candidates: []storage.RaceCalendarEvent{
				cnRow(597, "2026-11-15", "南昌市", "Unknown"),
			},
			wantKeep:   []string{"Nanchang Marathon"},
			wantLabels: map[uint64]string{},
			want:       mirrorDedupSummary{},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			keep, labels, got := planMirrorDedup(tc.upstream, tc.candidates)
			if got != tc.want {
				t.Fatalf("summary = %+v, want %+v", got, tc.want)
			}
			if gotNames := namesOf(keep); len(gotNames) != 0 || len(tc.wantKeep) != 0 {
				if diff := diffStrings(gotNames, tc.wantKeep); diff != "" {
					t.Fatalf("keep = %v, want %v", gotNames, tc.wantKeep)
				}
			}
			gotLabels := labelsOf(labels)
			if len(gotLabels) != len(tc.wantLabels) {
				t.Fatalf("labels = %+v (%d), want %d entries", gotLabels, len(gotLabels), len(tc.wantLabels))
			}
			for id, want := range tc.wantLabels {
				v, ok := gotLabels[id]
				if !ok {
					t.Fatalf("labels missing row %d", id)
				}
				if want == "" {
					if v != nil {
						t.Fatalf("row %d = %q, want a clear (nil)", id, *v)
					}
					continue
				}
				if v == nil || *v != want {
					t.Fatalf("row %d = %v, want %q", id, v, want)
				}
			}
		})
	}
}

// noCityRow is a CHN listing whose venue could not be parsed into a city.
func noCityRow(id uint64, date, label string) storage.RaceCalendarEvent {
	return storage.RaceCalendarEvent{
		ID: id, Source: storage.RaceSourceWorldAth, Country: "CHN",
		Name: "NoCity race", RaceDate: date, Label: strp(label),
	}
}

// noLabelRow is a CHN listing upstream awards no tier — its Label is nil, which
// is what a merge must propagate (a clear), not an empty string.
func noLabelRow(id uint64, date, city string, types ...string) storage.RaceCalendarEvent {
	row := waRow(id, date, city, "", types...)
	row.Label = nil
	return row
}

// waRowUSA is a foreign listing: same shape as waRow but a non-CHN country.
func waRowUSA(id uint64, date, city, label string) storage.RaceCalendarEvent {
	row := waRow(id, date, city, label)
	row.Country = "USA"
	return row
}

// diffStrings renders the first difference between two string slices, for a
// readable failure on the keep-order assertions.
func diffStrings(got, want []string) string {
	if len(got) != len(want) {
		return "length mismatch"
	}
	for i := range got {
		if got[i] != want[i] {
			return "element mismatch"
		}
	}
	return ""
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

// TestDriftCompatible pins the two T2-guard branches the plan-level table
// above cannot reach: the 10Km name token, and a stated WA race type (GW/GL)
// which merges without any name derivation. The merge/refuse/contradiction
// behaviour around them is covered by the TestPlanMirrorDedup cases.
func TestDriftCompatible(t *testing.T) {
	cases := []struct {
		name string
		in   storage.RaceCalendarEvent
		cn   storage.RaceCalendarEvent
		want bool
	}{
		{
			name: "10k name derives the 10Km token",
			in:   named(waRow(1, "2026-11-08", "杭州市", "Label", "Unknown"), "Hangzhou 10K"),
			cn:   cnRow(2, "2026-11-15", "杭州市", "10Km"),
			want: true,
		},
		{
			name: "a GW listing's stated Marathon needs no name derivation",
			in:   named(waRow(1, "2026-11-08", "上海市", "Platinum", "Marathon"), "Shanghai International"),
			cn:   cnRow(2, "2026-11-15", "上海市", "Marathon"),
			want: true,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := driftCompatible(tc.in, tc.cn); got != tc.want {
				t.Fatalf("driftCompatible = %v, want %v", got, tc.want)
			}
		})
	}
}
