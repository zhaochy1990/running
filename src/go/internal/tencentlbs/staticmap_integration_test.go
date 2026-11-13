//go:build integration

package tencentlbs

import (
	"bytes"
	"context"
	"image"
	_ "image/png"
	"io"
	"math"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"testing"
	"time"
)

// TestLiveCompressedTracks uses only synthetic coordinates and is opt-in:
// STRIDE_STATICMAP_TEST_KEY=<key> go test -tags integration ./internal/tencentlbs
func TestLiveCompressedTracks(t *testing.T) {
	key := os.Getenv("STRIDE_STATICMAP_TEST_KEY")
	if key == "" {
		t.Skip("STRIDE_STATICMAP_TEST_KEY is not set")
	}
	client := New(key, 20*time.Second)
	for _, segments := range []int{1, 2} {
		t.Run(map[int]string{1: "long", 2: "two_segments"}[segments], func(t *testing.T) {
			req := StaticMapRequest{Width: 482, Height: 210, Scale: 2}
			for segment := 0; segment < segments; segment++ {
				points := make([][2]float64, 256)
				for i := range points {
					theta := float64(i) * 2 * math.Pi / 255
					points[i] = [2]float64{31.224 + float64(segment)*0.02 + 0.004*math.Cos(theta), 121.55 + 0.006*math.Sin(theta)}
				}
				if segment == 0 {
					req.Markers = append(req.Markers, StaticMarker{Size: "small", Color: "green", Lat: points[0][0], Lng: points[0][1]})
				}
				if segment == segments-1 {
					req.Markers = append(req.Markers, StaticMarker{Size: "small", Color: "red", Lat: points[len(points)-1][0], Lng: points[len(points)-1][1]})
				}
				req.Paths = append(req.Paths, StaticPath{Color: "0xffffff", Weight: 19, Points: points})
				for i := 0; i < len(points); i += 8 {
					req.Paths = append(req.Paths, StaticPath{Color: "0xff0000", Weight: 13, Points: points[i : i+8]})
				}
			}
			png, err := client.FetchStaticMap(context.Background(), req)
			if err != nil {
				t.Fatalf("static map request failed: %v", err)
			}
			imageConfig, _, err := image.DecodeConfig(bytes.NewReader(png))
			if err != nil || imageConfig.Width != req.Width*req.Scale || imageConfig.Height != req.Height*req.Scale {
				t.Fatalf("unexpected PNG dimensions: %dx%d, error: %v", imageConfig.Width, imageConfig.Height, err)
			}
			if dir := os.Getenv("STRIDE_STATICMAP_TEST_OUTPUT_DIR"); dir != "" {
				if err := os.WriteFile(filepath.Join(dir, t.Name()[len("TestLiveCompressedTracks/"):]+".png"), png, 0600); err != nil {
					t.Fatalf("write synthetic image: %v", err)
				}
			}
		})
	}
}

// TestLiveTrackFraming checks that separated segments are actually visible,
// rather than assuming an HTTP 200 PNG implies a correctly framed map.
func TestLiveTrackFraming(t *testing.T) {
	key := os.Getenv("STRIDE_STATICMAP_TEST_KEY")
	if key == "" {
		t.Skip("STRIDE_STATICMAP_TEST_KEY is not set")
	}
	req := StaticMapRequest{
		Width: 482, Height: 210, Scale: 2,
		Paths: []StaticPath{
			{Color: "0x00ff00", Weight: 10, Points: [][2]float64{{31.224, 121.547}, {31.224, 121.553}}},
			{Color: "0x00ff00", Weight: 10, Points: [][2]float64{{31.244, 121.547}, {31.244, 121.553}}},
		},
	}
	client := New(key, 20*time.Second)
	requestURL, err := client.staticMapURL(req)
	if err != nil {
		t.Fatal(err)
	}
	baseURL, err := url.Parse(requestURL)
	if err != nil {
		t.Fatal(withoutRequestURL(err))
	}
	lat, lng, zoom, _ := FitCenterZoom(req)
	t.Logf("center=%f,%f zoom=%d paths=%d", lat, lng, zoom, len(req.Paths))
	for _, delta := range []int{0, -1} {
		t.Run("zoom_"+strconv.Itoa(zoom+delta), func(t *testing.T) {
			u := *baseURL
			q := u.Query()
			q.Set("zoom", strconv.Itoa(zoom+delta))
			u.RawQuery = q.Encode()
			httpReq, err := http.NewRequestWithContext(context.Background(), http.MethodGet, u.String(), nil)
			if err != nil {
				t.Fatal(withoutRequestURL(err))
			}
			resp, err := client.http.Do(httpReq)
			if err != nil {
				t.Fatal(withoutRequestURL(err))
			}
			defer resp.Body.Close()
			png, err := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
			if err != nil || resp.StatusCode != 200 {
				t.Fatalf("request failed: status %d, error %v", resp.StatusCode, err)
			}
			img, _, err := image.Decode(bytes.NewReader(png))
			if err != nil {
				t.Fatalf("decode PNG: %v", err)
			}
			// The provider antialiases/blends the bright green paths. Count
			// green pixels near the horizontal center in both halves so that
			// a PNG which crops either pause segment cannot pass.
			bounds := img.Bounds()
			top, bottom := 0, 0
			for y := bounds.Min.Y; y < bounds.Max.Y; y++ {
				for x := bounds.Dx() * 3 / 10; x < bounds.Dx()*7/10; x++ {
					r, g, b, _ := img.At(x, y).RGBA()
					if r < 0x9000 && b < 0x9000 && g > 0x9000 && g > r*5/4 && g > b*5/4 {
						if y < bounds.Dy()/2 {
							top++
						} else {
							bottom++
						}
					}
				}
			}
			if dir := os.Getenv("STRIDE_STATICMAP_TEST_OUTPUT_DIR"); dir != "" {
				if err := os.WriteFile(filepath.Join(dir, "framing-"+strconv.Itoa(zoom+delta)+".png"), png, 0600); err != nil {
					t.Fatal(err)
				}
			}
			t.Logf("zoom=%d green pixels: top=%d bottom=%d", zoom+delta, top, bottom)
			if top < 100 || bottom < 100 {
				t.Errorf("one or both synthetic route segments are not visible")
			}
		})
	}
}
