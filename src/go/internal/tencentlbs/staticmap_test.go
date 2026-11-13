package tencentlbs

import (
	"context"
	"math"
	"net/http"
	"net/http/httptest"
	"net/url"
	"reflect"
	"strconv"
	"strings"
	"testing"
	"time"
)

// pngBytes is a minimal valid PNG (8-byte signature + a stub IHDR-less body —
// only the signature matters to the client's response sniffing).
var pngBytes = append([]byte{0x89, 'P', 'N', 'G', '\r', '\n', 0x1a, '\n'}, 0, 0, 0, 0)

func validRequest() StaticMapRequest {
	return StaticMapRequest{
		Width: 492, Height: 260, Scale: 2,
		Paths: []StaticPath{
			{Color: "0xffffffff", Weight: 19, Points: [][2]float64{{31.2166, 121.5434}, {31.2246, 121.55529}}},
			{Color: "0x00a85a", Weight: 13, Points: [][2]float64{{31.2166, 121.5434}, {31.2246, 121.55529}}},
		},
		Markers: []StaticMarker{
			{Size: "small", Color: "green", Lat: 31.2166, Lng: 121.5434},
			{Size: "small", Color: "red", Lat: 31.2246, Lng: 121.55529},
		},
	}
}

func TestValidate(t *testing.T) {
	if err := validRequest().Validate(); err != nil {
		t.Fatalf("valid request rejected: %v", err)
	}
	cases := []struct {
		name string
		mut  func(*StaticMapRequest)
		want string
	}{
		{"width too small", func(r *StaticMapRequest) { r.Width = 10 }, "width"},
		{"width too large", func(r *StaticMapRequest) { r.Width = 2000 }, "width"},
		{"height too small", func(r *StaticMapRequest) { r.Height = 10 }, "height"},
		{"height too large", func(r *StaticMapRequest) { r.Height = 1300 }, "height"},
		{"bad scale", func(r *StaticMapRequest) { r.Scale = 3 }, "scale"},
		{"path single point", func(r *StaticMapRequest) { r.Paths[1].Points = [][2]float64{{31.2, 121.5}} }, "path 1"},
		{"marker color hex rejected", func(r *StaticMapRequest) { r.Markers[0].Color = "0x00ff00" }, "predefined marker color"},
		{"marker size bogus", func(r *StaticMapRequest) { r.Markers[0].Size = "huge" }, "predefined marker size"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			req := validRequest()
			tc.mut(&req)
			err := req.Validate()
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("got %v, want error containing %q", err, tc.want)
			}
		})
	}
	// Point-count ceilings: 2048 allowed, 2049 rejected; 257 paths rejected.
	big := validRequest()
	pts := make([][2]float64, 2048)
	for i := range pts {
		pts[i] = [2]float64{31.2, 121.5}
	}
	big.Paths = []StaticPath{{Color: "0x000000", Weight: 5, Points: pts}}
	if err := big.Validate(); err != nil {
		t.Fatalf("2048-point path should pass: %v", err)
	}
	pts = append(pts, [2]float64{31.2, 121.5})
	big.Paths[0].Points = pts
	if err := big.Validate(); err == nil {
		t.Fatal("2049-point path should fail")
	}
	many := validRequest()
	many.Paths = make([]StaticPath, 257)
	for i := range many.Paths {
		many.Paths[i] = StaticPath{Color: "0x000000", Weight: 5, Points: [][2]float64{{31.2, 121.5}, {31.3, 121.6}}}
	}
	if err := many.Validate(); err == nil {
		t.Fatal("257 paths should fail")
	}
}

func TestBuildStaticMapQuery(t *testing.T) {
	q, err := BuildStaticMapQuery(validRequest())
	if err != nil {
		t.Fatalf("build: %v", err)
	}
	// The documented wire format: size joined with '*', paths as
	// color|weight|lat,lng|lat,lng, markers as size|color|lat,lng — all URL
	// encoded ("|" → %7C).
	for _, want := range []string{
		"size=492%2A260",
		"scale=2",
		"path=color%3A0xffffffff%7Cweight%3A19%7C31.216600%2C121.543400%7C31.224600%2C121.555290",
		"path=color%3A0x00a85a%7Cweight%3A13",
		"markers=size%3Asmall%7Ccolor%3Agreen%7C31.216600%2C121.543400",
		"markers=size%3Asmall%7Ccolor%3Ared%7C31.224600%2C121.555290",
	} {
		if !strings.Contains(q, want) {
			t.Fatalf("query missing %q:\n%s", want, q)
		}
	}
	if strings.Contains(q, "key=") {
		t.Fatal("query must not embed the key; the client appends it")
	}
	if !strings.Contains(q, "center=") || !strings.Contains(q, "zoom=") {
		t.Fatal("query must carry the derived center and zoom")
	}
}

func TestBuildStaticMapQueryNothingToFit(t *testing.T) {
	req := validRequest()
	req.Paths = nil
	req.Markers = nil
	if _, err := BuildStaticMapQuery(req); err == nil {
		t.Fatal("empty request should fail to frame")
	}
}

func TestFitCenterZoom(t *testing.T) {
	// Spike V2 evidence track bbox (Shanghai, lat 31.2166~31.2246,
	// lng 121.5434~121.55529): the fit must be deterministic, zoom in a sane
	// street-level band, and the center inside the bbox.
	req := validRequest()
	lat, lng, zoom, ok := FitCenterZoom(req)
	if !ok {
		t.Fatal("expected a fit")
	}
	if lat < 31.2166 || lat > 31.2246 {
		t.Fatalf("center lat %v outside bbox", lat)
	}
	if lng < 121.5434 || lng > 121.55529 {
		t.Fatalf("center lng %v outside bbox", lng)
	}
	if zoom < 3 || zoom > 20 {
		t.Fatalf("zoom %d out of range", zoom)
	}
	lat2, lng2, zoom2, _ := FitCenterZoom(req)
	if lat != lat2 || lng != lng2 || zoom != zoom2 {
		t.Fatal("fit is not deterministic")
	}

	// Growing the bbox must not increase the zoom (a wider span needs a
	// smaller zoom to fit).
	req.Paths[0].Points = [][2]float64{{31.0, 121.3}, {31.5, 121.8}}
	_, _, zoomWide, _ := FitCenterZoom(req)
	if zoomWide > zoom {
		t.Fatalf("zoom grew with bbox: %d > %d", zoomWide, zoom)
	}

	// A single degenerate point frames at street level.
	req.Paths = []StaticPath{{Color: "0x0", Weight: 5, Points: [][2]float64{{31.2, 121.5}, {31.2, 121.5}}}}
	req.Markers = nil
	lat1, lng1, zoom1, ok1 := FitCenterZoom(req)
	if !ok1 || zoom1 != 17 || lat1 != 31.2 || lng1 != 121.5 {
		t.Fatalf("degenerate bbox fit = %v %v %d %v", lat1, lng1, zoom1, ok1)
	}

	// Markers alone can frame the map.
	req.Paths = nil
	req.Markers = []StaticMarker{{Size: "small", Color: "red", Lat: 31.21, Lng: 121.54}, {Size: "small", Color: "green", Lat: 31.23, Lng: 121.56}}
	if _, _, _, ok := FitCenterZoom(req); !ok {
		t.Fatal("markers alone should frame")
	}
}

func TestClientNotConfigured(t *testing.T) {
	client := New("", time.Second)
	if client.Configured() {
		t.Fatal("empty key must not be configured")
	}
	if _, err := client.FetchStaticMap(context.Background(), validRequest()); err == nil {
		t.Fatal("unconfigured client must error")
	}
}

func TestFetchStaticMap(t *testing.T) {
	var gotPath string
	var gotQuery url.Values
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotQuery = r.URL.Query()
		w.Header().Set("Content-Type", "image/png")
		_, _ = w.Write(pngBytes)
	}))
	defer srv.Close()

	client := NewWithEndpoint("secret-key", srv.URL, time.Second)
	if !client.Configured() {
		t.Fatal("keyed client must be configured")
	}
	png, err := client.FetchStaticMap(context.Background(), validRequest())
	if err != nil {
		t.Fatalf("fetch: %v", err)
	}
	if string(png) != string(pngBytes) {
		t.Fatal("PNG bytes not passed through")
	}
	if gotPath != "/" {
		t.Fatalf("unexpected path %q", gotPath)
	}
	if gotQuery.Get("key") != "secret-key" {
		t.Fatal("key must be appended server-side")
	}
	if gotQuery["path"] == nil || gotQuery["markers"] == nil {
		t.Fatal("path/markers params missing")
	}
}

func TestFetchStaticMapErrors(t *testing.T) {
	// Provider HTTP error.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusForbidden)
		_, _ = w.Write([]byte(`{"status":120,"message":"此key每日调用量已达到上限"}`))
	}))
	defer srv.Close()
	client := NewWithEndpoint("k", srv.URL, time.Second)
	if _, err := client.FetchStaticMap(context.Background(), validRequest()); err == nil {
		t.Fatal("HTTP 403 must fail")
	}

	// JSON error body with HTTP 200 (the API's observed error shape).
	srv2 := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"status":110,"message":"请求来源未被授权"}`))
	}))
	defer srv2.Close()
	client2 := NewWithEndpoint("k", srv2.URL, time.Second)
	if _, err := client2.FetchStaticMap(context.Background(), validRequest()); err == nil {
		t.Fatal("non-image 200 payload must fail")
	}

	// Invalid request never dials out.
	client3 := NewWithEndpoint("k", "http://127.0.0.1:1", time.Second)
	bad := validRequest()
	bad.Scale = 9
	if _, err := client3.FetchStaticMap(context.Background(), bad); err == nil {
		t.Fatal("invalid request must fail before dialing")
	}
}

// A normal activity produces a white casing and many colored chunks. The
// resulting request must fit under the upstream gateway's request-line limit.
func TestFetchLongTrackWithinURLBudget(t *testing.T) {
	points := make([][2]float64, 256)
	for i := range points {
		points[i] = [2]float64{31.2 + float64(i)*0.00001, 121.5 + float64(i)*0.00001}
	}
	req := validRequest()
	req.Paths = []StaticPath{{Color: "0xffffff", Weight: 19, Points: points}}
	for i := 0; i < len(points); i += 8 {
		req.Paths = append(req.Paths, StaticPath{Color: "0xff0000", Weight: 13, Points: points[i : i+8]})
	}
	req.Markers[0].Lat, req.Markers[0].Lng = points[0][0], points[0][1]
	req.Markers[1].Lat, req.Markers[1].Lng = points[len(points)-1][0], points[len(points)-1][1]

	var urlBytes int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		urlBytes = len("http://" + r.Host + r.URL.RequestURI())
		if urlBytes > 7000 {
			w.WriteHeader(http.StatusRequestURITooLong)
			return
		}
		_, _ = w.Write(pngBytes)
	}))
	defer srv.Close()

	client := NewWithEndpoint("synthetic-key", srv.URL, time.Second)
	if _, err := client.FetchStaticMap(context.Background(), req); err != nil {
		t.Fatalf("long route should return a PNG within budget (URL %d bytes): %v", urlBytes, err)
	}
	if urlBytes > 7000 {
		t.Fatalf("URL length %d exceeds budget", urlBytes)
	}
}

// decodePath reconstructs Tencent's cmp:1 path format for wire assertions.
func decodePath(t *testing.T, path string) [][2]float64 {
	t.Helper()
	parts := strings.Split(path, "|")
	compressed := false
	points := make([][2]float64, 0, len(parts))
	for _, part := range parts {
		if part == "cmp:1" {
			compressed = true
			continue
		}
		if strings.HasPrefix(part, "color:") || strings.HasPrefix(part, "weight:") {
			continue
		}
		values := strings.Split(part, ",")
		if len(values) != 2 {
			t.Fatalf("unexpected path component: %q", part)
		}
		a, err := strconv.ParseFloat(values[0], 64)
		if err != nil {
			t.Fatalf("invalid latitude: %v", err)
		}
		b, err := strconv.ParseFloat(values[1], 64)
		if err != nil {
			t.Fatalf("invalid longitude: %v", err)
		}
		if compressed && len(points) > 0 {
			prev := points[len(points)-1]
			a = prev[0] + a/1e6
			b = prev[1] + b/1e6
		}
		points = append(points, [2]float64{a, b})
	}
	return points
}

func assertPointNear(t *testing.T, got, want [2]float64) {
	t.Helper()
	if math.Abs(got[0]-want[0]) > 0.00000051 || math.Abs(got[1]-want[1]) > 0.00000051 {
		t.Fatalf("coordinate mismatch: got %v, want %v", got, want)
	}
}

func TestCompressedPathsRoundTrip(t *testing.T) {
	req := validRequest()
	req.Paths = []StaticPath{
		{Color: "0xff0000", Weight: 13, Points: [][2]float64{
			{31.223001, 121.549999}, {31.222998, 121.550004},
			{31.222998, 121.550004}, {31.223010, 121.549990},
		}},
		{Color: "0x00a85a", Weight: 5, Points: [][2]float64{
			{-31.223001, -121.549999}, {-31.223010, -121.549990},
		}},
	}
	lat, lng, zoom, _ := FitCenterZoom(req)
	q, err := url.ParseQuery(buildStaticMapQuery(req, lat, lng, zoom, true))
	if err != nil {
		t.Fatal(err)
	}
	if len(q["path"]) != len(req.Paths) {
		t.Fatalf("got %d paths, want %d", len(q["path"]), len(req.Paths))
	}
	for i, encoded := range q["path"] {
		if !strings.Contains(encoded, "|cmp:1|") || !strings.HasPrefix(encoded, "color:"+req.Paths[i].Color+"|weight:") {
			t.Fatalf("path %d lost encoding or style", i)
		}
		got := decodePath(t, encoded)
		if len(got) != len(req.Paths[i].Points) {
			t.Fatalf("path %d: got %d points, want %d", i, len(got), len(req.Paths[i].Points))
		}
		for j := range got {
			assertPointNear(t, got[j], req.Paths[i].Points[j])
		}
	}
}

func TestURLBudgetPreservesSegmentsAndOriginalFraming(t *testing.T) {
	req := validRequest()
	req.Paths = nil
	var first, last [2]float64
	for segment := 0; segment < 2; segment++ {
		points := make([][2]float64, 256)
		for i := range points {
			theta := float64(i) * 2 * math.Pi / 255
			points[i] = [2]float64{31.224 + float64(segment)*0.03 + 0.004*math.Cos(theta), 121.55 + 0.006*math.Sin(theta)}
		}
		if segment == 0 {
			first = points[0]
		}
		last = points[len(points)-1]
		req.Paths = append(req.Paths, StaticPath{Color: "0xffffff", Weight: 19, Points: points})
		for i := 0; i < len(points); i += 8 {
			req.Paths = append(req.Paths, StaticPath{Color: "0xff0000", Weight: 13, Points: points[i : i+8]})
		}
	}
	req.Markers[0].Lat, req.Markers[0].Lng = first[0], first[1]
	req.Markers[1].Lat, req.Markers[1].Lng = last[0], last[1]
	originalPoints := append([][2]float64(nil), req.Paths[0].Points...)
	centerLat, centerLng, zoom, _ := FitCenterZoom(req)

	client := NewWithEndpoint("synthetic-key", "https://example.test/staticmap", time.Second)
	encodedURL, err := client.staticMapURL(req)
	if err != nil {
		t.Fatalf("compress and simplify: %v", err)
	}
	if len(encodedURL) > maxStaticMapURLBytes {
		t.Fatalf("URL length %d exceeds budget", len(encodedURL))
	}
	parsed, err := url.Parse(encodedURL)
	if err != nil {
		t.Fatal(err)
	}
	q := parsed.Query()
	if got, want := q.Get("center"), formatCoord(centerLat)+","+formatCoord(centerLng); got != want {
		t.Fatalf("center after simplification = %s, want %s", got, want)
	}
	if got := q.Get("zoom"); got != strconv.Itoa(zoom) {
		t.Fatalf("zoom after simplification = %s, want %d", got, zoom)
	}
	if len(q["path"]) != len(req.Paths) || len(q["markers"]) != len(req.Markers) {
		t.Fatalf("segments or markers lost: %d paths, %d markers", len(q["path"]), len(q["markers"]))
	}
	if !reflect.DeepEqual(req.Paths[0].Points, originalPoints) {
		t.Fatal("input points were mutated")
	}
	reduced := false
	for i, encoded := range q["path"] {
		path := req.Paths[i]
		if !strings.Contains(encoded, "|cmp:1|") || !strings.HasPrefix(encoded, "color:"+path.Color+"|weight:"+strconv.Itoa(path.Weight)+"|") {
			t.Fatalf("path %d lost style or compression", i)
		}
		got := decodePath(t, encoded)
		if len(got) < MinPathPoints || len(got) > providerMaxPathPoints {
			t.Fatalf("path %d has invalid point count %d", i, len(got))
		}
		assertPointNear(t, got[0], path.Points[0])
		assertPointNear(t, got[len(got)-1], path.Points[len(path.Points)-1])
		if len(got) < len(path.Points) {
			reduced = true
		}
	}
	if !reduced {
		t.Fatal("oversized multi-segment fixture did not exercise simplification")
	}
	for i, marker := range req.Markers {
		want := "size:" + marker.Size + "|color:" + marker.Color + "|" + formatCoord(marker.Lat) + "," + formatCoord(marker.Lng)
		if q["markers"][i] != want {
			t.Fatalf("marker %d changed", i)
		}
	}
}

func TestProviderPathPointLimit(t *testing.T) {
	req := validRequest()
	points := make([][2]float64, 1500)
	for i := range points {
		points[i] = [2]float64{31.2 + float64(i)*0.0000001, 121.5 + float64(i)*0.0000001}
	}
	req.Paths = []StaticPath{{Color: "0xff0000", Weight: 5, Points: points}}
	client := NewWithEndpoint("test-key", "https://example.test/map", time.Second)
	result, err := client.staticMapURL(req)
	if err != nil {
		t.Fatal(err)
	}
	u, err := url.Parse(result)
	if err != nil {
		t.Fatal(err)
	}
	got := decodePath(t, u.Query()["path"][0])
	if len(got) > providerMaxPathPoints {
		t.Fatalf("path contains %d points, provider limit is %d", len(got), providerMaxPathPoints)
	}
	assertPointNear(t, got[0], points[0])
	assertPointNear(t, got[len(got)-1], points[len(points)-1])
}

func TestUnrepresentableURLFailsWithoutDialing(t *testing.T) {
	req := validRequest()
	req.Paths = make([]StaticPath, MaxPaths)
	for i := range req.Paths {
		req.Paths[i] = StaticPath{Color: "0xffffff", Weight: 19, Points: [][2]float64{{31.2, 121.5}, {31.3, 121.6}}}
	}
	called := false
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { called = true }))
	defer srv.Close()
	client := NewWithEndpoint("test-secret", srv.URL, time.Second)
	_, err := client.FetchStaticMap(context.Background(), req)
	if err == nil || !strings.Contains(err.Error(), "exceeds URL budget") {
		t.Fatalf("want a clear budget error, got %v", err)
	}
	if called {
		t.Fatal("unrepresentable request must not reach the provider")
	}
	if strings.Contains(err.Error(), "test-secret") {
		t.Fatal("error leaked the key")
	}
}

func TestFetchErrorsDoNotLeakKey(t *testing.T) {
	secret := "test-secret +/credential"
	client := NewWithEndpoint(secret, "http://127.0.0.1:1", time.Second)
	_, err := client.FetchStaticMap(context.Background(), validRequest())
	if err == nil || strings.Contains(err.Error(), secret) || strings.Contains(err.Error(), url.QueryEscape(secret)) {
		t.Fatalf("network error missing or leaked the key: %v", err)
	}

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadGateway)
		_, _ = w.Write([]byte("upstream error " + secret + " " + url.QueryEscape(secret)))
	}))
	defer srv.Close()
	client = NewWithEndpoint(secret, srv.URL, time.Second)
	_, err = client.FetchStaticMap(context.Background(), validRequest())
	if err == nil || strings.Contains(err.Error(), secret) || strings.Contains(err.Error(), url.QueryEscape(secret)) {
		t.Fatalf("provider error missing or leaked the key: %v", err)
	}
}

func TestValidateCoordinates(t *testing.T) {
	for _, point := range [][2]float64{{math.NaN(), 121.5}, {31.2, math.Inf(1)}, {91, 121.5}, {31.2, -181}} {
		req := validRequest()
		req.Paths[0].Points[0] = point
		if err := req.Validate(); err == nil {
			t.Fatalf("invalid path coordinate %v accepted", point)
		}
		req = validRequest()
		req.Markers[0].Lat, req.Markers[0].Lng = point[0], point[1]
		if err := req.Validate(); err == nil {
			t.Fatalf("invalid marker coordinate %v accepted", point)
		}
	}
}

func TestFitCenterZoomIncludesNorthSouthSpan(t *testing.T) {
	req := StaticMapRequest{
		Width: 482, Height: 210, Scale: 2,
		Paths: []StaticPath{{Color: "0xff0000", Weight: 5, Points: [][2]float64{{31.224, 121.55}, {31.244, 121.55}}}},
	}
	lat, _, zoom, ok := FitCenterZoom(req)
	if !ok {
		t.Fatal("north-south track should frame")
	}
	if lat < 31.224 || lat > 31.244 {
		t.Fatalf("center latitude %v outside track", lat)
	}
	span := math.Abs(latToUnit(31.224)-latToUnit(31.244)) * tileSizePx * math.Exp2(float64(zoom))
	if span > float64(req.Height)*(1-2*fitPadding)+1e-9 {
		t.Fatalf("north-south track spans %.1f px at zoom %d, exceeds available height", span, zoom)
	}
}

func TestFitCenterZoomRespectsTencentZoomBounds(t *testing.T) {
	for _, scale := range []int{1, 2} {
		req := StaticMapRequest{
			Width: 482, Height: 210, Scale: scale,
			Paths: []StaticPath{{Color: "0xff0000", Weight: 5, Points: [][2]float64{{31.224, 121.55}, {31.224, 121.55}}}},
		}
		_, _, zoom, ok := FitCenterZoom(req)
		maxZoom := 18
		if scale == 2 {
			maxZoom = 17
		}
		if !ok || zoom < 4 || zoom > maxZoom {
			t.Fatalf("scale=%d zoom=%d ok=%v, want zoom in [4,%d]", scale, zoom, ok, maxZoom)
		}
	}
}
