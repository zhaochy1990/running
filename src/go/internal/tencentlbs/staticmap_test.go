package tencentlbs

import (
	"context"
	"net/http"
	"net/http/httptest"
	"net/url"
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
	if !ok1 || zoom1 != 18 || lat1 != 31.2 || lng1 != 121.5 {
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
