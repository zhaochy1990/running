package competitioncalendar

import "testing"

func TestParseLocation(t *testing.T) {
	cases := []struct {
		name, venue, country, wantProvince, wantCity string
	}{
		// Chinese city -> Chinese name + province.
		{"china plain", "Xiamen (CHN)", "CHN", "福建省", "厦门市"},
		{"china municipality", "Shanghai (CHN)", "CHN", "上海市", "上海市"},
		{"china district in venue", "Pukou, Nanjing (CHN)", "CHN", "江苏省", "南京市"},
		// A venue naming the host district/county directly must still resolve to
		// the PREFECTURE: the 中国田协 catalogue discards its address's third
		// segment, so its city is always the prefecture, and the
		// race_calendar_wa_label step joins the two sources on
		// (race_date, city). A district here silently costs that race its World
		// Athletics tier — these four each did exactly that in 2026.
		{"china district venue name", "Gaochun (CHN)", "CHN", "江苏省", "南京市"},
		{"china county-level city venue", "Xichang (CHN)", "CHN", "四川省", "凉山彝族自治州"},
		{"china district venue name 2", "Yangling (CHN)", "CHN", "陕西省", "咸阳市"},
		{"china county venue name", "Zhenning (CHN)", "CHN", "贵州省", "安顺市"},
		// Foreign cities keep the upstream English name.
		{"foreign plain", "Valencia (ESP)", "ESP", "", "Valencia"},
		{"foreign multi-word", "Cape Elizabeth, ME (USA)", "USA", "Maine", "Cape Elizabeth"},
		// US state code -> English state name.
		{"us state", "Houston, TX (USA)", "USA", "Texas", "Houston"},
		{"us state with venue prefix", "Home Depot Backyard, Atlanta, GA (USA)", "USA", "Georgia", "Atlanta"},
		{"us state multi-word city", "New York, NY (USA)", "USA", "New York", "New York"},
		// Venue name + city (non-US) -> last segment is the city.
		{"venue then city", "Green Point Stadium, Cape Town (RSA)", "RSA", "", "Cape Town"},
		// US federal district and the state-code lookup must be US-gated.
		{"us district", "Washington, DC (USA)", "USA", "District of Columbia", "Washington"},
		// A foreign 2-letter suffix that collides with a US state code must NOT
		// be treated as a US state (so province must NOT become "Michigan"). The
		// city falls back to the last segment — a known limitation for foreign
		// province suffixes; no such venue exists in the current data.
		{"italy province not us state", "Milano, MI (ITA)", "ITA", "", "MI"},
		{"empty venue", "", "GER", "", ""},
	}
	for _, c := range cases {
		province, city := parseLocation(c.venue, c.country)
		if province != c.wantProvince || city != c.wantCity {
			t.Errorf("%s: parseLocation(%q, %q) = (%q, %q), want (%q, %q)",
				c.name, c.venue, c.country, province, city, c.wantProvince, c.wantCity)
		}
	}
}
