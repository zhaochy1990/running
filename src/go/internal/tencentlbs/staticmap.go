// Package tencentlbs wraps the Tencent LBS (腾讯位置服务) static-map WebService
// API (https://apis.map.qq.com/ws/staticmap/v2/, devops#943 spike → devops#944
// map layer plan B). The API key is a secret that must never ship inside the
// miniprogram bundle, so the only caller is the Go API's server-side proxy
// (internal/api postermap.go): clients POST a path/marker spec, the proxy adds
// the key, fetches the PNG, and streams the bytes back.
//
// Wire format notes (official docs, lbs.qq.com static_v2): path and markers
// style attributes and positions are all "|" separated; a path carries at
// least 2 and at most 2048 positions, at most 256 path params per request;
// markers colors are limited to ten predefined names; size is "width*height"
// with 50≤width≤1680 and 50≤height≤1200, and scale=2 doubles the output
// pixels (recommended size ≤ 900*900 at scale 2).
package tencentlbs

import (
	"context"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// DefaultStaticMapURL is the official static-map endpoint (HTTPS only).
const DefaultStaticMapURL = "https://apis.map.qq.com/ws/staticmap/v2/"

// Provider limits documented by the static-map API.
const (
	MinSizePx = 50
	MaxWidth  = 1680
	MaxHeight = 1200

	MinPathPoints = 2
	MaxPathPoints = 2048
	MaxPaths      = 256

	MaxMarkers = 50

	// Keep the complete upstream URL comfortably below the observed 8 KiB
	// gateway limit. Tencent's static-map documentation caps each path at 800.
	maxStaticMapURLBytes  = 7000
	providerMaxPathPoints = 800
)

// tileSizePx is the web-mercator tile edge the zoom ladder counts (256px at
// every zoom), the same convention the V2 spike validated against the native
// <map> includePoints fit.
const tileSizePx = 256

// StaticPath is one colored polyline on the map: GCJ-02 positions as
// [lat, lng] pairs plus the documented style knobs. Color is "0xRRGGBB" or
// "0xAARRGGBB"; weight is the stroke width in pixels.
type StaticPath struct {
	Color  string       `json:"color"`
	Weight int          `json:"weight"`
	Points [][2]float64 `json:"points"`
}

// StaticMarker is one pin. Color must be one of the API's predefined names
// (black, brown, green, purple, yellow, blue, gray, orange, red, white);
// size one of tiny, small, mid, large.
type StaticMarker struct {
	Size  string  `json:"size"`
	Color string  `json:"color"`
	Lat   float64 `json:"lat"`
	Lng   float64 `json:"lng"`
}

// StaticMapRequest is the proxy's wire contract: the final map composition,
// already in GCJ-02. Center and zoom are NOT part of it — the client derives
// them from the track bbox with a deterministic fit (padding on both axes),
// reusing the bbox+padding approach the V2 spike validated, so the poster's
// framing does not depend on the provider's implicit auto-fit.
type StaticMapRequest struct {
	Width   int            `json:"width"`
	Height  int            `json:"height"`
	Scale   int            `json:"scale"`
	Paths   []StaticPath   `json:"paths"`
	Markers []StaticMarker `json:"markers"`
}

// Client fetches static maps with a fixed key.
type Client struct {
	key      string
	endpoint string
	http     *http.Client
}

// New builds a client. An empty key leaves it unusable (Configured reports
// false) so the capability ships dark until the key lands, mirroring the amap
// and COS patterns.
func New(apiKey string, timeout time.Duration) *Client {
	if timeout <= 0 {
		timeout = 10 * time.Second
	}
	return &Client{key: apiKey, endpoint: DefaultStaticMapURL, http: &http.Client{Timeout: timeout}}
}

// NewWithEndpoint overrides the endpoint (tests and self-hosted proxies).
func NewWithEndpoint(apiKey, endpoint string, timeout time.Duration) *Client {
	client := New(apiKey, timeout)
	if endpoint != "" {
		client.endpoint = endpoint
	}
	return client
}

// Configured reports whether static-map fetches can run (nil-safe; the api.PosterMapFetcher port)..
func (c *Client) Configured() bool { return c != nil && c.key != "" }

// markerColors are the ten predefined marker color names.
var markerColors = map[string]bool{
	"black": true, "brown": true, "green": true, "purple": true, "yellow": true,
	"blue": true, "gray": true, "orange": true, "red": true, "white": true,
}

// markerSizes are the four documented marker size names.
var markerSizes = map[string]bool{"tiny": true, "small": true, "mid": true, "large": true}

// Validate checks the request against the provider's documented limits.
func (r StaticMapRequest) Validate() error {
	if r.Width < MinSizePx || r.Width > MaxWidth {
		return fmt.Errorf("width %d out of range [%d, %d]", r.Width, MinSizePx, MaxWidth)
	}
	if r.Height < MinSizePx || r.Height > MaxHeight {
		return fmt.Errorf("height %d out of range [%d, %d]", r.Height, MinSizePx, MaxHeight)
	}
	if r.Scale != 1 && r.Scale != 2 {
		return errors.New("scale must be 1 or 2")
	}
	if len(r.Paths) > MaxPaths {
		return fmt.Errorf("%d paths exceed the %d limit", len(r.Paths), MaxPaths)
	}
	for i, p := range r.Paths {
		if len(p.Points) < MinPathPoints || len(p.Points) > MaxPathPoints {
			return fmt.Errorf("path %d has %d points, out of range [%d, %d]", i, len(p.Points), MinPathPoints, MaxPathPoints)
		}
		for _, point := range p.Points {
			if !validCoordinate(point[0], point[1]) {
				return fmt.Errorf("path %d contains invalid coordinates", i)
			}
		}
	}
	if len(r.Markers) > MaxMarkers {
		return fmt.Errorf("%d markers exceed the %d limit", len(r.Markers), MaxMarkers)
	}
	for i, m := range r.Markers {
		if !markerColors[m.Color] {
			return fmt.Errorf("marker %d color %q is not a predefined marker color", i, m.Color)
		}
		if !markerSizes[m.Size] {
			return fmt.Errorf("marker %d size %q is not a predefined marker size", i, m.Size)
		}
		if !validCoordinate(m.Lat, m.Lng) {
			return fmt.Errorf("marker %d contains invalid coordinates", i)
		}
	}
	return nil
}

func validCoordinate(lat, lng float64) bool {
	return !math.IsNaN(lat) && !math.IsNaN(lng) && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180
}

// FetchStaticMap validates the request, derives center+zoom from the path
// bbox, calls the endpoint with the key, and returns the PNG bytes.
func (c *Client) FetchStaticMap(ctx context.Context, req StaticMapRequest) ([]byte, error) {
	if !c.Configured() {
		return nil, errors.New("tencentlbs: client not configured")
	}
	requestURL, err := c.staticMapURL(req)
	if err != nil {
		return nil, err
	}
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodGet, requestURL, nil)
	if err != nil {
		return nil, fmt.Errorf("tencentlbs: build request: %w", withoutRequestURL(err))
	}
	resp, err := c.http.Do(httpReq)
	if err != nil {
		return nil, fmt.Errorf("tencentlbs: fetch: %w", withoutRequestURL(err))
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	if err != nil {
		return nil, fmt.Errorf("tencentlbs: read response: %w", err)
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("tencentlbs: provider returned HTTP %d: %s", resp.StatusCode, safeResponsePreview(body, c.key))
	}
	// The endpoint answers image/png on success; anything else is the API's
	// JSON error payload with a 200 (observed shape: {"status":..., "message":...}).
	if len(body) == 0 || !looksLikePNG(body) {
		return nil, fmt.Errorf("tencentlbs: provider returned non-image payload: %s", safeResponsePreview(body, c.key))
	}
	return body, nil
}

// looksLikePNG checks the 8-byte PNG signature.
func looksLikePNG(b []byte) bool {
	sig := []byte{0x89, 'P', 'N', 'G', '\r', '\n', 0x1a, '\n'}
	if len(b) < len(sig) {
		return false
	}
	return string(b[:len(sig)]) == string(sig)
}

// safeResponsePreview removes the key before truncating provider error bodies.
func safeResponsePreview(body []byte, key string) string {
	text := strings.ReplaceAll(string(body), key, "<redacted>")
	if encoded := url.QueryEscape(key); encoded != key {
		text = strings.ReplaceAll(text, encoded, "<redacted>")
	}
	if len(text) > 200 {
		return text[:200]
	}
	return text
}

// withoutRequestURL strips URL-bearing network errors before they reach logs.
// The URL contains both the server-held key and the user's track coordinates.
func withoutRequestURL(err error) error {
	var urlErr *url.Error
	if errors.As(err, &urlErr) {
		return urlErr.Err
	}
	return err
}

// staticMapURL retains the existing wire format for short requests. Longer
// requests use Tencent's delta encoding and then progressively simplify each
// independent path until the complete URL fits the conservative budget.
func (c *Client) staticMapURL(req StaticMapRequest) (string, error) {
	query, err := BuildStaticMapQuery(req)
	if err != nil {
		return "", err
	}
	key := "&key=" + url.QueryEscape(c.key)
	makeURL := func(q string) string { return c.endpoint + "?" + q + key }
	providerCompatible := true
	for _, path := range req.Paths {
		if len(path.Points) > providerMaxPathPoints {
			providerCompatible = false
			break
		}
	}
	if providerCompatible && len(makeURL(query)) <= maxStaticMapURLBytes {
		return makeURL(query), nil
	}

	// Keep the original framing even when path points must be simplified.
	lat, lng, zoom, _ := FitCenterZoom(req)
	paths := make([]StaticPath, len(req.Paths))
	copy(paths, req.Paths)
	for i := range paths {
		paths[i].Points = samplePath(paths[i].Points, providerMaxPathPoints)
	}
	req.Paths = paths
	for {
		query = buildStaticMapQuery(req, lat, lng, zoom, true)
		requestURL := makeURL(query)
		if len(requestURL) <= maxStaticMapURLBytes {
			return requestURL, nil
		}
		reduced := false
		for i := range paths {
			if len(paths[i].Points) > MinPathPoints {
				limit := (len(paths[i].Points) + 1) / 2
				if limit < MinPathPoints {
					limit = MinPathPoints
				}
				paths[i].Points = samplePath(paths[i].Points, limit)
				reduced = true
			}
		}
		if !reduced {
			return "", errors.New("tencentlbs: map request exceeds URL budget after path simplification")
		}
	}
}

// samplePath keeps both endpoints and samples the interior without mutating
// the caller's points. Independent paths remain separate across pauses.
func samplePath(points [][2]float64, limit int) [][2]float64 {
	if len(points) <= limit {
		return points
	}
	out := make([][2]float64, limit)
	for i := range out {
		out[i] = points[i*(len(points)-1)/(limit-1)]
	}
	return out
}

// BuildStaticMapQuery renders the original uncompressed query without a key.
func BuildStaticMapQuery(req StaticMapRequest) (string, error) {
	if err := req.Validate(); err != nil {
		return "", fmt.Errorf("tencentlbs: %w", err)
	}
	lat, lng, zoom, ok := FitCenterZoom(req)
	if !ok {
		return "", errors.New("tencentlbs: no path or marker positions to frame")
	}
	return buildStaticMapQuery(req, lat, lng, zoom, false), nil
}

func buildStaticMapQuery(req StaticMapRequest, lat, lng float64, zoom int, compressed bool) string {
	values := url.Values{}
	values.Set("center", formatCoord(lat)+","+formatCoord(lng))
	values.Set("zoom", strconv.Itoa(zoom))
	values.Set("size", strconv.Itoa(req.Width)+"*"+strconv.Itoa(req.Height))
	values.Set("scale", strconv.Itoa(req.Scale))
	for _, p := range req.Paths {
		var b strings.Builder
		b.WriteString("color:")
		b.WriteString(p.Color)
		b.WriteString("|weight:")
		b.WriteString(strconv.Itoa(p.Weight))
		if compressed {
			b.WriteString("|cmp:1")
		}
		var prevLat, prevLng int64
		for i, pt := range p.Points {
			b.WriteString("|")
			if !compressed {
				b.WriteString(formatCoord(pt[0]))
				b.WriteString(",")
				b.WriteString(formatCoord(pt[1]))
				continue
			}
			latMicro, lngMicro := int64(math.Round(pt[0]*1e6)), int64(math.Round(pt[1]*1e6))
			if i == 0 {
				b.WriteString(formatCoord(float64(latMicro) / 1e6))
				b.WriteString(",")
				b.WriteString(formatCoord(float64(lngMicro) / 1e6))
			} else {
				b.WriteString(strconv.FormatInt(latMicro-prevLat, 10))
				b.WriteString(",")
				b.WriteString(strconv.FormatInt(lngMicro-prevLng, 10))
			}
			prevLat, prevLng = latMicro, lngMicro
		}
		values.Add("path", b.String())
	}
	for _, m := range req.Markers {
		var b strings.Builder
		b.WriteString("size:")
		b.WriteString(m.Size)
		b.WriteString("|color:")
		b.WriteString(m.Color)
		b.WriteString("|")
		b.WriteString(formatCoord(m.Lat))
		b.WriteString(",")
		b.WriteString(formatCoord(m.Lng))
		values.Add("markers", b.String())
	}
	return values.Encode()
}

// formatCoord renders a coordinate with 6 decimal places (≈0.1m), matching
// the precision used by Tencent's compressed path deltas.
func formatCoord(v float64) string {
	return strconv.FormatFloat(v, 'f', 6, 64)
}

// fitPadding is the share of each axis reserved as whitespace around the
// track bbox (POC padRatio 0.045 → production breathing room 8%).
const fitPadding = 0.08

// FitCenterZoom derives the map center and integer zoom that frame every path
// point (markers included) inside the request size minus padding on both
// axes. It mirrors the bbox+padding fit the map-snapshot spike validated on
// the native <map> includePoints path (V2): deterministic, no reliance on the
// provider's implicit auto-fit framing. The bool reports whether there was
// anything to frame.
func FitCenterZoom(req StaticMapRequest) (lat, lng float64, zoom int, ok bool) {
	minLat, maxLat := math.Inf(1), math.Inf(-1)
	minLng, maxLng := math.Inf(1), math.Inf(-1)
	consider := func(a, b float64) {
		if a < minLat {
			minLat = a
		}
		if a > maxLat {
			maxLat = a
		}
		if b < minLng {
			minLng = b
		}
		if b > maxLng {
			maxLng = b
		}
	}
	for _, p := range req.Paths {
		for _, pt := range p.Points {
			consider(pt[0], pt[1])
		}
	}
	for _, m := range req.Markers {
		consider(m.Lat, m.Lng)
	}
	if math.IsInf(minLat, 1) {
		return 0, 0, 0, false
	}

	// Web-mercator normalized coordinates in [0,1].
	xMin, xMax := lngToUnit(minLng), lngToUnit(maxLng)
	// Mercator y grows southward, so the northern latitude is the lower y.
	yMin, yMax := latToUnit(maxLat), latToUnit(minLat)
	availW := float64(req.Width) * (1 - 2*fitPadding)
	availH := float64(req.Height) * (1 - 2*fitPadding)
	fit := 0.0
	if dx := xMax - xMin; dx > 0 {
		fit = availW / (tileSizePx * dx)
	}
	if dy := yMax - yMin; dy > 0 {
		fitY := availH / (tileSizePx * dy)
		if fit == 0 || fitY < fit {
			fit = fitY
		}
	}
	// Tencent supports zoom 4–18; high-resolution scale 2 caps it at 17.
	maxZoom := 18
	if req.Scale == 2 {
		maxZoom = 17
	}
	if fit <= 0 {
		// Degenerate bbox (a single point): frame at the closest supported level.
		return minLat, minLng, maxZoom, true
	}
	z := int(math.Floor(math.Log2(fit)))
	if z < 4 {
		z = 4
	}
	if z > maxZoom {
		z = maxZoom
	}
	// Center is the mercator midpoint, converted back to geographic
	// latitude so high-latitude spans stay centered.
	cx := (xMin + xMax) / 2
	cy := (yMin + yMax) / 2
	return unitToLat(cy), unitToLng(cx), z, true
}

// lngToUnit maps longitude to the mercator x unit square [0,1].
func lngToUnit(lng float64) float64 { return (lng + 180) / 360 }

// unitToLng inverts lngToUnit.
func unitToLng(x float64) float64 { return x*360 - 180 }

// latToUnit maps latitude (degrees) to the mercator y unit square [0,1]
// (north = 0), using the standard spherical mercator projection.
func latToUnit(lat float64) float64 {
	phi := lat * math.Pi / 180
	y := math.Log(math.Tan(math.Pi/4 + phi/2))
	return 0.5 - y/(2*math.Pi)
}

// unitToLat inverts latToUnit.
func unitToLat(y float64) float64 {
	latRad := 2*math.Atan(math.Exp((0.5-y)*2*math.Pi)) - math.Pi/2
	return latRad * 180 / math.Pi
}
