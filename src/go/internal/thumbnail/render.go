package thumbnail

import (
	"bytes"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"math"
)

// RenderPNG draws a normalized polyline onto a transparent, size×size PNG,
// fitted to the largest circle inscribed in the canvas.
//
// The circle fit is deliberate: activity lists draw the thumbnail in a circular
// slot, and fitting the square would slice both ends off any route that runs
// corner to corner — a straight diagonal out-and-back would lose its turnaround.
//
// The route is stroked by stamping a filled disc at sub-pixel intervals along
// every segment, which gives round caps and joins for free and avoids pulling in
// a rasterizer for what is a handful of line segments.
func RenderPNG(points []Point, size int, stroke color.RGBA) ([]byte, error) {
	if size < 8 {
		return nil, fmt.Errorf("thumbnail: canvas size %d is too small", size)
	}
	if len(points) == 0 {
		return nil, fmt.Errorf("thumbnail: empty polyline")
	}

	img := image.NewRGBA(image.Rect(0, 0, size, size))
	scale := float64(size-1) / float64(Viewbox)
	// Stroke stays proportional to the canvas so callers can render at any
	// resolution without the line turning into a hairline or a blob.
	radius := float64(size) / 48
	centre := float64(size-1) / 2

	px := make([][2]float64, len(points))
	var maxDist float64
	for i, p := range points {
		x, y := p.X*scale, p.Y*scale
		px[i] = [2]float64{x, y}
		maxDist = math.Max(maxDist, math.Hypot(x-centre, y-centre))
	}
	if maxDist > 0 {
		if fit := math.Min(1, (centre-radius)/maxDist); fit < 1 {
			for i := range px {
				px[i][0] = centre + (px[i][0]-centre)*fit
				px[i][1] = centre + (px[i][1]-centre)*fit
			}
		}
	}

	stamp := func(x, y float64) {
		for sy := math.Floor(y - radius); sy <= math.Ceil(y+radius); sy++ {
			for sx := math.Floor(x - radius); sx <= math.Ceil(x+radius); sx++ {
				if math.Hypot(sx-x, sy-y) > radius {
					continue
				}
				ix, iy := int(sx), int(sy)
				if ix < 0 || iy < 0 || ix >= size || iy >= size {
					continue
				}
				img.SetRGBA(ix, iy, stroke)
			}
		}
	}

	if len(px) == 1 {
		stamp(px[0][0], px[0][1])
	}
	for i := 1; i < len(px); i++ {
		x0, y0 := px[i-1][0], px[i-1][1]
		x1, y1 := px[i][0], px[i][1]
		// Half-pixel steps: below that the discs already overlap.
		steps := max(int(math.Ceil(math.Hypot(x1-x0, y1-y0)/0.5)), 1)
		for s := 0; s <= steps; s++ {
			t := float64(s) / float64(steps)
			stamp(x0+(x1-x0)*t, y0+(y1-y0)*t)
		}
	}

	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		return nil, fmt.Errorf("thumbnail: encode png: %w", err)
	}
	return buf.Bytes(), nil
}
