package api

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sort"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"

	"github.com/zhaochy1990/stride/internal/storage"
	"github.com/zhaochy1990/stride/internal/utils/timefmt"
)

// The dashboard handler tests run on the same in-memory fakes as the rest of
// the calendar surface; the bucketing under test lives in the HTTP layer, so
// the fakes only need to mirror the storage read's filtering (including the
// never-maintained OR branch, at its event-level resolution).

func (f *fakeRaceCalendarStore) ListRaceCalendarDashboardRows(_ context.Context, scope storage.RaceDashboardScope) ([]storage.RaceCalendarEvent, error) {
	var out []storage.RaceCalendarEvent
	for _, row := range f.events {
		if scope.Country != "" && row.Country != scope.Country {
			continue
		}
		inDomain := true
		switch {
		case scope.FromDate != "":
			inDomain = row.RaceDate >= scope.FromDate
		case scope.ToDate != "":
			inDomain = row.RaceDate < scope.ToDate
		}
		if !inDomain && scope.IncludeNeverMaintainedSync &&
			row.Origin == storage.RaceOriginSync && !row.Published &&
			!row.HasContent() && len(row.AdminOverrides) == 0 {
			inDomain = true
		}
		if !inDomain {
			continue
		}
		out = append(out, row)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].RaceDate != out[j].RaceDate {
			return out[i].RaceDate < out[j].RaceDate
		}
		if out[i].Name != out[j].Name {
			return out[i].Name < out[j].Name
		}
		return out[i].ID < out[j].ID
	})
	return out, nil
}

func (f *fakeRaceCalendarStore) ListRaceCalendarItemsByEventIDs(_ context.Context, eventIDs []uint64) ([]storage.RaceCalendarItem, error) {
	want := make(map[uint64]bool, len(eventIDs))
	for _, id := range eventIDs {
		want[id] = true
	}
	var out []storage.RaceCalendarItem
	for _, item := range f.items {
		if want[item.RaceEventID] {
			out = append(out, item)
		}
	}
	return out, nil
}

func (f *fakeRaceContentStore) ListRaceCityContentByCities(_ context.Context, cities []string) ([]storage.RaceCityContent, error) {
	var out []storage.RaceCityContent
	for _, city := range cities {
		if row, ok := f.cities[city]; ok {
			out = append(out, *row)
		}
	}
	return out, nil
}

// --- harness -----------------------------------------------------------------

type dashboardHarness struct {
	svc      *Service
	calendar *fakeRaceCalendarStore
	cities   *fakeRaceContentStore
	key      *rsa.PrivateKey
}

func newDashboardHarness(t *testing.T) *dashboardHarness {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatalf("gen key: %v", err)
	}
	verifier, err := NewJWTVerifierFromKeyWithAdmin(&key.PublicKey, testIssuer, testAudience, testAdminAudience)
	if err != nil {
		t.Fatalf("verifier: %v", err)
	}
	calendar := newFakeRaceCalendarStore()
	cities := newFakeRaceContentStore()
	svc := NewService(Config{
		Auth:              NewAuthenticator(testToken, verifier),
		RaceCalendarStore: calendar,
		RaceContentStore:  cities,
	})
	return &dashboardHarness{svc: svc, calendar: calendar, cities: cities, key: key}
}

func (h *dashboardHarness) token(t *testing.T, audience, role string) map[string]string {
	t.Helper()
	claims := jwt.MapClaims{
		"sub": "33333333-3333-4333-8333-333333333333", "iss": testIssuer, "aud": audience,
		"exp": time.Now().Add(time.Hour).Unix(), "iat": time.Now().Unix(),
	}
	if role != "" {
		claims["role"] = role
	}
	signed, err := jwt.NewWithClaims(jwt.SigningMethodRS256, claims).SignedString(h.key)
	if err != nil {
		t.Fatalf("sign: %v", err)
	}
	return map[string]string{"Authorization": "Bearer " + signed}
}

func (h *dashboardHarness) adminToken(t *testing.T) map[string]string {
	return h.token(t, testAdminAudience, "admin")
}

func (h *dashboardHarness) do(t *testing.T, path string, headers map[string]string) *httptest.ResponseRecorder {
	t.Helper()
	r := httptest.NewRequest(http.MethodGet, path, nil)
	for k, v := range headers {
		r.Header.Set(k, v)
	}
	w := httptest.NewRecorder()
	h.svc.Router().ServeHTTP(w, r)
	return w
}

func (h *dashboardHarness) getDashboard(t *testing.T, query string) raceDashboardResponse {
	t.Helper()
	w := h.do(t, "/api/admin/races/dashboard"+query, h.adminToken(t))
	if w.Code != http.StatusOK {
		t.Fatalf("GET dashboard = %d: %s", w.Code, w.Body.String())
	}
	var got raceDashboardResponse
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	return got
}

// dashboardDate formats a Shanghai civil date offset from today by n days.
func dashboardDate(n int) string {
	return timefmt.ShanghaiToday().AddDate(0, 0, n).Format("2006-01-02")
}

// completeItem satisfies every data-gate field.
func completeItem(eventID uint64, name string) storage.RaceCalendarItem {
	fee, quota := 100, 20000
	lat, lng := 31.23, 121.47
	return storage.RaceCalendarItem{
		RaceEventID:      eventID,
		Name:             name,
		Type:             "Marathon",
		StartTime:        strPtrAPITest("07:00"),
		EntryFee:         &fee,
		Quota:            &quota,
		DistanceKm:       floatPtrAPITest(42.195),
		StartPoint:       &storage.RacePoint{Name: "起点", Lat: &lat, Lng: &lng},
		FinishPoint:      &storage.RacePoint{Name: "终点", Lat: &lat, Lng: &lng},
		RouteDescription: strPtrAPITest("起点→南京东路→终点"),
	}
}

// seedCompliantRace seeds a race that passes all three gates.
func seedCompliantRace(h *dashboardHarness, name, date string) storage.RaceCalendarEvent {
	event := h.calendar.seedEvent(storage.RaceCalendarEvent{
		Source: "中国田协", Origin: storage.RaceOriginSync, Name: name,
		RaceDate: date, Country: "CHN",
		Province:       strPtrAPITest("福建省"),
		City:           strPtrAPITest("厦门市"),
		Climate:        &storage.RaceClimate{Summary: "十月厦门温和湿润"},
		WeatherWindows: []storage.RaceWeatherWindow{{WindowStart: "10-01", WindowEnd: "10-15"}, {WindowStart: "10-16", WindowEnd: "10-31"}},
	})
	h.calendar.seedItem(completeItem(event.ID, "全程马拉松"))
	_, err := h.cities.UpsertRaceCityContent(context.Background(), &storage.RaceCityContent{
		City:  "厦门市",
		Intro: &storage.CityIntro{Overview: "城市概览"},
	})
	if err != nil {
		panic(err)
	}
	return event
}

// --- tests -------------------------------------------------------------------

func TestRaceDashboard_TierGuards(t *testing.T) {
	h := newDashboardHarness(t)
	if w := h.do(t, "/api/admin/races/dashboard", nil); w.Code != http.StatusUnauthorized {
		t.Errorf("without token = %d, want 401", w.Code)
	}
	if w := h.do(t, "/api/admin/races/dashboard", internalHdr()); w.Code != http.StatusForbidden {
		t.Errorf("as internal = %d, want 403", w.Code)
	}
	if w := h.do(t, "/api/admin/races/dashboard", h.token(t, testAudience, "")); w.Code != http.StatusForbidden {
		t.Errorf("as user = %d, want 403", w.Code)
	}
}

func TestRaceDashboard_ParamValidation(t *testing.T) {
	h := newDashboardHarness(t)
	for _, tc := range []struct{ query, code string }{
		{"?time=bogus", "invalid_time"},
		{"?scope=bogus", "invalid_scope"},
		{"?time=upcoming&scope=bogus", "invalid_scope"},
	} {
		w := h.do(t, "/api/admin/races/dashboard"+tc.query, h.adminToken(t))
		if w.Code != http.StatusBadRequest {
			t.Errorf("%s = %d, want 400", tc.query, w.Code)
			continue
		}
		var got struct {
			Error string `json:"error"`
		}
		if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil || got.Error != tc.code {
			t.Errorf("%s error = %q (%v), want %q", tc.query, got.Error, err, tc.code)
		}
	}
}

func TestRaceDashboard_Bucketing(t *testing.T) {
	h := newDashboardHarness(t)

	// 数据齐全待发布:三项门槛全过。
	compliant := seedCompliantRace(h, "待发布赛事", dashboardDate(30))
	// 已发布:即便有缺口也一票进已发布桶,gates 仍然可见。
	published := h.calendar.seedEvent(storage.RaceCalendarEvent{
		Source: "中国田协", Origin: storage.RaceOriginSync, Name: "已发布赛事",
		RaceDate: dashboardDate(10), Country: "CHN", City: strPtrAPITest("厦门市"),
		Published: true,
	})
	h.calendar.seedItem(storage.RaceCalendarItem{RaceEventID: published.ID, Name: "全程马拉松", Type: "Marathon", Origin: storage.RaceOriginSync})
	// 同步新增:未开赛域内的裸同步行。
	h.calendar.seedEvent(storage.RaceCalendarEvent{
		Source: "中国田协", Origin: storage.RaceOriginSync, Name: "裸同步行",
		RaceDate: dashboardDate(60), Country: "CHN",
	})
	// 同步新增(无视 time):过去年份的裸同步行也必须留在桶里。
	h.calendar.seedEvent(storage.RaceCalendarEvent{
		Source: "中国田协", Origin: storage.RaceOriginSync, Name: "过去年份裸行",
		RaceDate: "2019-04-01", Country: "CHN",
	})
	// 缺信息:维护过(有内容)但门槛不全的未开赛行。
	missing := h.calendar.seedEvent(storage.RaceCalendarEvent{
		Source: "中国田协", Origin: storage.RaceOriginSync, Name: "缺信息行",
		RaceDate: dashboardDate(20), Country: "CHN", City: strPtrAPITest("厦门市"),
		Climate: &storage.RaceClimate{Summary: "有气候"},
	})
	h.calendar.seedItem(storage.RaceCalendarItem{RaceEventID: missing.ID, Name: "半程马拉松", Type: "HalfMarathon", Origin: storage.RaceOriginSync})
	// 过去年份里被维护过的行:upcoming 视图绝不能让它漏进来(存储 OR 分支的
	// 超集泄漏必须被丢弃)。
	pastMaintained := h.calendar.seedEvent(storage.RaceCalendarEvent{
		Source: "中国田协", Origin: storage.RaceOriginSync, Name: "过去维护行",
		RaceDate: "2020-01-01", Country: "CHN", City: strPtrAPITest("厦门市"),
		Climate: &storage.RaceClimate{Summary: "有气候"},
	})
	h.calendar.seedItem(completeItem(pastMaintained.ID, "全程马拉松"))

	got := h.getDashboard(t, "") // 默认 upcoming + cn

	if names := bucketNames(got.Pending); len(names) != 1 || names[0] != "待发布赛事" {
		t.Errorf("pending = %v, want [待发布赛事]", names)
	}
	if names := bucketNames(got.Published); len(names) != 1 || names[0] != "已发布赛事" {
		t.Errorf("published = %v, want [已发布赛事]", names)
	}
	if names := bucketNames(got.NewSync); len(names) != 2 || names[0] != "过去年份裸行" || names[1] != "裸同步行" {
		t.Errorf("new_sync = %v, want [过去年份裸行 裸同步行] (race_date 升序)", names)
	}
	if names := bucketNames(got.Missing); len(names) != 1 || names[0] != "缺信息行" {
		t.Errorf("missing = %v, want [缺信息行]", names)
	}
	if got.Pending.Races[0].ID != compliant.ID || got.Published.Races[0].ID != published.ID {
		t.Error("bucket rows carry the wrong ids")
	}
	// 已发布行也带 gates(可见缺口)。
	if got.Published.Races[0].Gates == nil {
		t.Error("published row must carry gates")
	}

	// 同步新增行省略 gates/observations(JSON 键不存在,而非 null)。
	w := h.do(t, "/api/admin/races/dashboard", h.adminToken(t))
	var raw struct {
		NewSync struct {
			Races []map[string]json.RawMessage `json:"races"`
		} `json:"new_sync"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &raw); err != nil {
		t.Fatalf("decode raw: %v", err)
	}
	for _, row := range raw.NewSync.Races {
		for _, key := range []string{"gates", "observations"} {
			if _, ok := row[key]; ok {
				t.Errorf("new_sync row %s must omit %q", row["name"], key)
			}
		}
	}
}

func TestRaceDashboard_TimeAndScope(t *testing.T) {
	h := newDashboardHarness(t)

	seedCompliantRace(h, "未来赛事", dashboardDate(30))
	h.calendar.seedEvent(storage.RaceCalendarEvent{
		Source: "中国田协", Origin: storage.RaceOriginSync, Name: "过去赛事",
		RaceDate: dashboardDate(-30), Country: "CHN", City: strPtrAPITest("厦门市"),
		Climate: &storage.RaceClimate{Summary: "有气候"},
	})
	h.calendar.seedEvent(storage.RaceCalendarEvent{
		Source: "中国田协", Origin: storage.RaceOriginSync, Name: "海外赛事",
		RaceDate: dashboardDate(45), Country: "USA",
		Climate: &storage.RaceClimate{Summary: "有气候(维护过)"},
	})
	h.calendar.seedEvent(storage.RaceCalendarEvent{
		Source: "中国田协", Origin: storage.RaceOriginSync, Name: "过去裸行",
		RaceDate: "2021-11-01", Country: "CHN",
	})

	// upcoming(默认):不含过去维护行,含过去裸行(同步新增无视 time),不含海外行。
	upcoming := h.getDashboard(t, "")
	if names := bucketNames(upcoming.Pending); len(names) != 1 || names[0] != "未来赛事" {
		t.Errorf("upcoming pending = %v, want [未来赛事]", names)
	}
	if names := bucketNames(upcoming.Missing); len(names) != 0 {
		t.Errorf("upcoming missing = %v, want empty (过去赛事不在 upcoming 域)", names)
	}
	if names := bucketNames(upcoming.NewSync); len(names) != 1 || names[0] != "过去裸行" {
		t.Errorf("upcoming new_sync = %v, want [过去裸行]", names)
	}

	// past:维护行进入 missing,未来赛事不在。
	past := h.getDashboard(t, "?time=past")
	if names := bucketNames(past.Missing); len(names) != 1 || names[0] != "过去赛事" {
		t.Errorf("past missing = %v, want [过去赛事]", names)
	}
	if names := bucketNames(past.Pending); len(names) != 0 {
		t.Errorf("past pending = %v, want empty", names)
	}
	if names := bucketNames(past.NewSync); len(names) != 1 || names[0] != "过去裸行" {
		t.Errorf("past new_sync = %v, want [过去裸行]", names)
	}

	// all:两个域都出现。
	all := h.getDashboard(t, "?time=all")
	if names := bucketNames(all.Pending); len(names) != 1 || names[0] != "未来赛事" {
		t.Errorf("all pending = %v, want [未来赛事]", names)
	}
	if names := bucketNames(all.Missing); len(names) != 1 || names[0] != "过去赛事" {
		t.Errorf("all missing = %v, want [过去赛事]", names)
	}

	// scope=all:海外行进入(缺信息:无 item、无城市)。
	allScope := h.getDashboard(t, "?scope=all")
	found := false
	for _, row := range allScope.Missing.Races {
		if row.Name == "海外赛事" {
			found = true
		}
	}
	if !found {
		t.Error("scope=all must include the non-CHN row")
	}
	if names := bucketNames(h.getDashboard(t, "?scope=cn").Missing); len(names) != 0 {
		t.Errorf("scope=cn missing = %v, want empty (本用例内中国行均合规)", names)
	}
}

func TestRaceDashboard_GateDetails(t *testing.T) {
	h := newDashboardHarness(t)

	// 无 item 的维护行:manual 起源、零 item → data.no_items(真裸行会进同步
	// 新增桶,不会走到门槛判定,所以这里用 manual 行验证裸行判缺);
	// 城市介绍存在但 intro 为空 → 城市门槛不过;无气候无天气窗 → 缺两项。
	h.calendar.seedEvent(storage.RaceCalendarEvent{
		Source: storage.RaceSourceManual, Origin: storage.RaceOriginManual, Name: "无项目行",
		RaceDate: dashboardDate(15), Country: "CHN", City: strPtrAPITest("厦门市"),
	})
	if _, err := h.cities.UpsertRaceCityContent(context.Background(), &storage.RaceCityContent{City: "厦门市"}); err != nil {
		t.Fatalf("seed city: %v", err)
	}

	// 逐 item 缺口:占位路线、缺终点、缺 quota;城市门槛过(杭州有 intro),
	// 天气只缺 weather_windows(有 climate、只有 1 个窗)。
	partial := h.calendar.seedEvent(storage.RaceCalendarEvent{
		Source: "中国田协", Origin: storage.RaceOriginSync, Name: "缺口行",
		RaceDate: dashboardDate(16), Country: "CHN", City: strPtrAPITest("杭州市"),
		Climate:        &storage.RaceClimate{Summary: "有气候"},
		WeatherWindows: []storage.RaceWeatherWindow{{WindowStart: "10-01", WindowEnd: "10-15"}},
	})
	if _, err := h.cities.UpsertRaceCityContent(context.Background(), &storage.RaceCityContent{
		City:  "杭州市",
		Intro: &storage.CityIntro{Overview: "杭州概览"},
	}); err != nil {
		t.Fatalf("seed hangzhou: %v", err)
	}
	bad := completeItem(partial.ID, "全程马拉松")
	bad.RouteDescription = strPtrAPITest("（注：待补充路线")
	bad.FinishPoint = &storage.RacePoint{Name: "终点"}
	bad.Quota = nil
	h.calendar.seedItem(bad)

	got := h.getDashboard(t, "")
	if len(got.Missing.Races) != 2 {
		t.Fatalf("missing = %d rows, want 2", len(got.Missing.Races))
	}

	bare := findRaceRow(t, got.Missing, "无项目行")
	if bare.Gates == nil || !bare.Gates.Data.NoItems {
		t.Fatalf("bare row must report data.no_items, got %+v", bare.Gates)
	}
	if bare.Gates.City.OK {
		t.Error("city gate: content row without intro must fail")
	}
	if len(bare.Gates.Weather.Missing) != 2 {
		t.Fatalf("weather missing = %v, want [climate weather_windows]", bare.Gates.Weather.Missing)
	}

	row := findRaceRow(t, got.Missing, "缺口行")
	if row.Gates.Data.OK {
		t.Error("data gate must fail")
	}
	if len(row.Gates.Data.Items) != 1 {
		t.Fatalf("items = %d, want 1", len(row.Gates.Data.Items))
	}
	want := []string{"route_description", "finish_point", "quota"}
	gotMissing := row.Gates.Data.Items[0].Missing
	if len(gotMissing) != len(want) {
		t.Fatalf("missing = %v, want %v", gotMissing, want)
	}
	for i, name := range want {
		if gotMissing[i] != name {
			t.Fatalf("missing = %v, want %v", gotMissing, want)
		}
	}
	if !row.Gates.City.OK {
		t.Error("city gate with intro must pass")
	}
	if row.Gates.Weather.OK {
		t.Error("weather gate with one window must fail")
	}
	if len(row.Gates.Weather.Missing) != 1 || row.Gates.Weather.Missing[0] != "weather_windows" {
		t.Fatalf("weather missing = %v, want [weather_windows]", row.Gates.Weather.Missing)
	}
}

func findRaceRow(t *testing.T, b raceDashboardBucket, name string) raceDashboardRace {
	t.Helper()
	for _, row := range b.Races {
		if row.Name == name {
			return row
		}
	}
	t.Fatalf("row %q not in bucket", name)
	return raceDashboardRace{}
}

func TestRaceDashboard_PendingObservations(t *testing.T) {
	h := newDashboardHarness(t)
	seedCompliantRace(h, "合规赛事", dashboardDate(30))

	got := h.getDashboard(t, "")
	if len(got.Pending.Races) != 1 {
		t.Fatalf("pending = %d rows, want 1", len(got.Pending.Races))
	}
	obs := got.Pending.Races[0].Observations
	if obs == nil {
		t.Fatal("pending row must carry observations")
	}
	// 三项门槛全过但观察层全空:11 项全部未维护。
	if len(obs.Missing) != 11 {
		t.Fatalf("observations.missing = %v (%d), want all 11", obs.Missing, len(obs.Missing))
	}
}

func bucketNames(b raceDashboardBucket) []string {
	names := make([]string, 0, len(b.Races))
	for _, row := range b.Races {
		names = append(names, row.Name)
	}
	return names
}
