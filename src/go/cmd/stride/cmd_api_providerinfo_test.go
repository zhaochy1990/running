package main

import "testing"

// TestWatchCapabilityLabels locks the curated, user-facing watch-capability
// lists (Chinese, fixed order) that GET /api/users/me/watch returns per
// provider. COROS advertises 4, Garmin 3 — Garmin must NOT advertise strength
// push (unimplemented). Guards against accidental edits to the product decision.
func TestWatchCapabilityLabels(t *testing.T) {
	cases := map[string][]string{
		"coros":  {"同步运动数据", "同步健康数据", "推送跑步课表", "推送力量训练"},
		"garmin": {"同步运动数据", "同步健康数据", "推送跑步课表"},
	}
	for provider, want := range cases {
		got := watchCapabilityLabels[provider]
		if len(got) != len(want) {
			t.Fatalf("%s caps = %v, want %v", provider, got, want)
		}
		for i := range want {
			if got[i] != want[i] {
				t.Errorf("%s[%d] = %q, want %q", provider, i, got[i], want[i])
			}
		}
	}
	for _, c := range watchCapabilityLabels["garmin"] {
		if c == "推送力量训练" {
			t.Error("garmin must not advertise 推送力量训练 (strength push is unimplemented)")
		}
	}
}
