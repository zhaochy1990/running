package racetypes

import (
	"reflect"
	"testing"
)

// TestFromWACategory covers the two trusted ranking categories and the
// everything-else fallback. GW/GL were validated against 2023–2026 WA
// calendars (40 marathons / 6 halves, zero exceptions); A/B/C/D/E are quality
// tiers that mix distances and must stay Unknown.
func TestFromWACategory(t *testing.T) {
	tests := []struct {
		category string
		want     []string
	}{
		{"GW", []string{Marathon}},     // e.g. Tokyo Marathon, C&D Xiamen Marathon
		{"GL", []string{HalfMarathon}}, // e.g. Meishan Renshou Half Marathon
		{"A", []string{Unknown}},       // quality tier, mixed calendar population
		{"B", []string{Unknown}},       // "Aramco Houston Half Marathon" is B — must not guess
		{"E", []string{Unknown}},
		{"", []string{Unknown}},
		{"GX", []string{Unknown}},
	}
	for _, tt := range tests {
		if got := FromWACategory(tt.category); !reflect.DeepEqual(got, tt.want) {
			t.Errorf("FromWACategory(%q) = %v, want %v", tt.category, got, tt.want)
		}
	}
}

// TestFromChinaItems exercises the mapping with real values observed in the
// 中国田协 searchCompetitionMls raceItem field (2959 races sampled 2026-09).
func TestFromChinaItems(t *testing.T) {
	tests := []struct {
		name  string
		items []string
		want  []string
	}{
		{"plain full", []string{"全程"}, []string{Marathon}},
		{"plain half", []string{"半程"}, []string{HalfMarathon}},
		{"multi-item string", []string{"全程、半程、其他"}, []string{Marathon, HalfMarathon, Other}},
		{"chinese multi with marathon word", []string{"马拉松、半程马拉松、迷你马拉松"}, []string{Marathon, HalfMarathon, Other}},
		{"full+half array", []string{"全程", "半程"}, []string{Marathon, HalfMarathon}},
		{"exact marathon distance", []string{"42.195公里"}, []string{Marathon}},
		{"exact half distance", []string{"21.0975公里"}, []string{HalfMarathon}},
		{"half decorates distance", []string{"半程马拉松（21.0975公里）"}, []string{HalfMarathon}},
		{"plain distance", []string{"10公里"}, []string{"10Km"}},
		{"km unit variant", []string{"4km"}, []string{"4Km"}},
		{"KM unit variant", []string{"6KM"}, []string{"6Km"}},
		{"chinese numeral ten", []string{"十公里"}, []string{"10Km"}},
		{"约 prefix", []string{"约5公里"}, []string{"5Km"}},
		{"event-kind suffix around distance", []string{"5公里亲子跑"}, []string{"5Km"}},
		{"parenthesized distance", []string{"迷你马拉松（3公里）"}, []string{"3Km"}},
		{"decoration both sides", []string{"绿色公益跑 ：3公里"}, []string{"3Km"}},
		{"decimal normalized", []string{"5.20公里"}, []string{"5.2Km"}},
		{"health run with distance", []string{"健康跑（10公里）"}, []string{"10Km"}},
		{"ultra distance stays Km", []string{"50公里"}, []string{"50Km"}},
		{"relay at marathon distance", []string{"42公里接力赛"}, []string{Marathon}},
		{"relay at half distance", []string{"21公里接力赛"}, []string{HalfMarathon}},
		{"relay without distance", []string{"马拉松接力"}, []string{Other}},
		{"fun run kinds", []string{"迷你"}, []string{Other}},
		{"fun run parenthesized km", []string{"欢乐跑（约5公里）"}, []string{"5Km"}},
		{"full keyword outranks relay", []string{"全程接力组"}, []string{Marathon}},
		{"distance outranks marathon word", []string{"环岛马拉松31公里"}, []string{"31Km"}},
		{"bare marathon word", []string{"亲子跑3公里", "马拉松"}, []string{"3Km", Marathon}},
		{"no classifiable marker", []string{"10英里"}, []string{Unknown}},
		{"no unit no keyword", []string{"约5"}, []string{Unknown}},
		{"nil items", nil, []string{Unknown}},
		{"empty items", []string{}, []string{Unknown}},
		{"blank strings", []string{"", " "}, []string{Unknown}},
		{"dedup", []string{"全程", "42.195公里", "全程"}, []string{Marathon}},
	}
	for _, tt := range tests {
		if got := FromChinaItems(tt.items); !reflect.DeepEqual(got, tt.want) {
			t.Errorf("%s: FromChinaItems(%q) = %v, want %v", tt.name, tt.items, got, tt.want)
		}
	}
}
