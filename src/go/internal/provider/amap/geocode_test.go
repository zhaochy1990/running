package amap

import (
	"context"
	"math"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// Reference pairs: 天安门广场 is the canonical test point for the GCJ-02
// transform (Amap GCJ-02 ≈ 116.397428, 39.90923; WGS84 GPS ≈ 116.3913,
// 39.9075). The offset in Beijing is ~500-600 m, which the assertions below
// verify loosely enough for datum-level checks and tightly enough to catch a
// swapped lat/lng or a missing transform.
func TestGCJ02ToWGS84ReferencePoints(t *testing.T) {
	// Tiananmen is the canonical anchor pair for the GCJ-02 transform.
	lat, lng := GCJ02ToWGS84(39.90923, 116.397428)
	if abs(lat-39.9075) > 0.001 || abs(lng-116.3913) > 0.001 {
		t.Errorf("Tiananmen: GCJ02ToWGS84 = (%.6f, %.6f), want near (39.9075, 116.3913)", lat, lng)
	}
	// Elsewhere in China assert the offset magnitude only: the field is a
	// smooth warp whose direction rotates with position, so hand-remembered
	// coordinate pairs are unreliable, but the magnitude stays within
	// 100-700 metres.
	for _, point := range [][2]float64{{31.239665, 121.490317}, {22.547, 114.061}} {
		wgsLat, wgsLng := GCJ02ToWGS84(point[0], point[1])
		metres := haversineMetres(point[0], point[1], wgsLat, wgsLng)
		if metres < 100 || metres > 700 {
			t.Errorf("offset at (%v, %v) = %.0f m, want 100-700 m", point[0], point[1], metres)
		}
		if wgsLat == point[0] && wgsLng == point[1] {
			t.Errorf("transform left (%v, %v) untouched inside China", point[0], point[1])
		}
	}
}

func haversineMetres(lat1, lng1, lat2, lng2 float64) float64 {
	const r = 6371000.0
	toRad := func(v float64) float64 { return v * math.Pi / 180 }
	dLat := toRad(lat2 - lat1)
	dLng := toRad(lng2 - lng1)
	a := math.Sin(dLat/2)*math.Sin(dLat/2) + math.Cos(toRad(lat1))*math.Cos(toRad(lat2))*math.Sin(dLng/2)*math.Sin(dLng/2)
	return r * 2 * math.Atan2(math.Sqrt(a), math.Sqrt(1-a))
}

func TestWGS84ToGCJ02RoundTrip(t *testing.T) {
	// Round-tripping through the forward transform must return the original
	// WGS84 point within GPS accuracy.
	for _, point := range [][2]float64{{39.9075, 116.3913}, {31.2377, 121.4839}, {22.5431, 114.0579}} {
		gcjLat, gcjLng := WGS84ToGCJ02(point[0], point[1])
		lat, lng := GCJ02ToWGS84(gcjLat, gcjLng)
		if abs(lat-point[0]) > 1e-6 || abs(lng-point[1]) > 1e-6 {
			t.Errorf("round trip of (%v, %v) drifted to (%.8f, %.8f)", point[0], point[1], lat, lng)
		}
	}
	// Outside China the datums coincide.
	lat, lng := WGS84ToGCJ02(51.5074, -0.1278)
	if lat != 51.5074 || lng != -0.1278 {
		t.Errorf("outside China transform moved the point to (%v, %v)", lat, lng)
	}
}

func TestGeocodeConvertsToWGS84(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("address") == "" || r.URL.Query().Get("key") == "" {
			t.Error("request missing address or key")
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"1","info":"OK","geocodes":[{"formatted_address":"北京市东城区东长安街天安门广场","location":"116.397428,39.90923","level":"兴趣点"}]}`))
	}))
	defer server.Close()
	client := NewWithEndpoint("test-key", server.URL, time.Second)
	result, err := client.Geocode(context.Background(), "天安门广场", "北京市")
	if err != nil {
		t.Fatalf("Geocode: %v", err)
	}
	// The stored point must be WGS84 (GPS-comparable), not Amap's GCJ-02.
	if abs(result.Latitude-39.9075) > 0.001 || abs(result.Longitude-116.3913) > 0.001 {
		t.Fatalf("geocode result = (%.6f, %.6f), want WGS84 near (39.9075, 116.3913)", result.Latitude, result.Longitude)
	}
	if result.FormattedAddress == "" || result.Level != "兴趣点" {
		t.Fatalf("geocode result = %+v, want address and level", result)
	}
}

func TestGeocodeSurfacesProviderFailures(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"status":"0","info":"INVALID_USER_KEY","geocodes":[]}`))
	}))
	defer server.Close()
	client := NewWithEndpoint("bad-key", server.URL, time.Second)
	if _, err := client.Geocode(context.Background(), "天安门广场", ""); err == nil {
		t.Fatal("provider error must surface, not vanish")
	}

	empty := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"status":"1","info":"OK","geocodes":[]}`))
	}))
	defer empty.Close()
	noHit := NewWithEndpoint("k", empty.URL, time.Second)
	if _, err := noHit.Geocode(context.Background(), "不存在的地点", ""); err == nil {
		t.Fatal("empty geocodes must be an error")
	}

	if _, err := New("", time.Second).Geocode(context.Background(), "x", ""); err == nil {
		t.Fatal("unconfigured client must refuse to geocode")
	}
	if New("", time.Second).IsConfigured() {
		t.Fatal("empty key must report unconfigured")
	}
}

func abs(v float64) float64 {
	if v < 0 {
		return -v
	}
	return v
}
