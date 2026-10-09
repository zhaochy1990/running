package competitioncalendar

import (
	"testing"

	"github.com/zhaochy1990/stride/internal/storage"
)

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
			want:       mirrorDedupSummary{Kept: 1, TypeRefused: 1, Cleared: 1},
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
			want:     mirrorDedupSummary{Kept: 1},
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
			want:       mirrorDedupSummary{Kept: 1, Ambiguous: 1, Cleared: 2},
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
			want:       mirrorDedupSummary{Kept: 2, Ambiguous: 2, Cleared: 1},
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
			want:     mirrorDedupSummary{Kept: 1},
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
			want:     mirrorDedupSummary{Kept: 1},
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
			want:       mirrorDedupSummary{Deduped: 1, Kept: 2, Stamped: 1},
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
