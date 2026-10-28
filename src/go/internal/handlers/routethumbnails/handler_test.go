package routethumbnails

import (
	"bytes"
	"image/color"
	"image/png"
	"testing"

	"github.com/zhaochy1990/stride/internal/thumbnail"
)

// The thumbnail sits on a light card since the theme flip (devops#817), so the
// stroke ink must be the dark textPrimary #2C3340 — the earlier near-white
// stroke, tuned to the old dark card, is invisible on white. The constant is
// pinned directly because RenderPNG takes its colour as a parameter: only a
// test reading strokeColor catches the handler drifting back to an unusable
// value.
func TestStrokeColorIsTheLightThemeInk(t *testing.T) {
	want := color.RGBA{R: 0x2c, G: 0x33, B: 0x40, A: 0xff}
	if strokeColor != want {
		t.Fatalf("strokeColor = %+v, want the devops#817 light-theme ink %+v", strokeColor, want)
	}

	// Then render with the handler's own constant and sample the pixels, so the
	// exact bytes that get uploaded are covered, not just the declared value.
	// Same corner-to-corner route the renderer tests use: it crosses the whole
	// canvas, so a wrong or transparent ink shows up as zero matching pixels.
	points := []thumbnail.Point{
		{X: thumbnail.Padding, Y: thumbnail.Viewbox - thumbnail.Padding},
		{X: thumbnail.Viewbox / 2, Y: thumbnail.Viewbox / 2},
		{X: thumbnail.Viewbox - thumbnail.Padding, Y: thumbnail.Padding},
	}
	raw, err := thumbnail.RenderPNG(points, canvasSize, strokeColor)
	if err != nil {
		t.Fatalf("RenderPNG: %v", err)
	}
	img, err := png.Decode(bytes.NewReader(raw))
	if err != nil {
		t.Fatalf("decode png: %v", err)
	}

	ink := 0
	for y := range canvasSize {
		for x := range canvasSize {
			r, g, b, a := img.At(x, y).RGBA()
			if a == 0 {
				continue
			}
			// At() widens 8-bit channels to 16-bit by multiplying by 257.
			if r == 0x2c*257 && g == 0x33*257 && b == 0x40*257 {
				ink++
			}
		}
	}
	if ink == 0 {
		t.Fatal("no stroke pixel matches the light-theme ink")
	}
}
