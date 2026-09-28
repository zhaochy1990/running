package amap

import "math"

// GCJ-02 is China's statutory obfuscated datum: every domestic map (Amap
// included) serves GCJ-02, while GPS hardware records WGS84. The two differ
// by roughly 100–700 m inside China and coincide outside. Storing one for
// the other silently corrupts every spatial join, so all conversions happen
// here once.

const (
	a  = 6378245.0              // semi-major axis of the Krasovsky ellipsoid
	ee = 0.00669342162296594323 // eccentricity squared
)

// GCJ02ToWGS84 inverts the forward transform by fixed-point iteration: each
// round re-anchors to the ORIGINAL GCJ-02 coordinate minus the forward delta
// at the current estimate. Accumulating subtractions instead diverges because
// the delta's trigonometric terms vary quickly with position.
func GCJ02ToWGS84(lat, lng float64) (float64, float64) {
	wgsLat, wgsLng := lat, lng
	for range 4 {
		dLat, dLng := wgs84ToGCJ02Delta(wgsLat, wgsLng)
		wgsLat = lat - dLat
		wgsLng = lng - dLng
	}
	return wgsLat, wgsLng
}

// WGS84ToGCJ02 applies the forward transform inside China and is the identity
// elsewhere.
func WGS84ToGCJ02(lat, lng float64) (float64, float64) {
	if !insideChina(lat, lng) {
		return lat, lng
	}
	dLat, dLng := wgs84ToGCJ02Delta(lat, lng)
	return lat + dLat, lng + dLng
}

func wgs84ToGCJ02Delta(lat, lng float64) (dLat, dLng float64) {
	if !insideChina(lat, lng) {
		return 0, 0
	}
	radLat := lat / 180.0 * math.Pi
	magic := math.Sin(radLat)
	magic = 1 - ee*magic*magic
	sqrtMagic := math.Sqrt(magic)

	// The public reference implementation parameterises both polynomials by
	// (x, y) = (lng-105, lat-35); forgetting the offsets skews the result by
	// ~0.1 degrees, an order of magnitude larger than the datum offset.
	x, y := lng-105.0, lat-35.0
	latPoly := -100.0 + 2.0*x + 3.0*y + 0.2*y*y + 0.1*x*y + 0.2*math.Sqrt(math.Abs(x))
	latPoly += (20.0*math.Sin(6.0*x*math.Pi) + 20.0*math.Sin(2.0*x*math.Pi)) * 2.0 / 3.0
	latPoly += (20.0*math.Sin(y*math.Pi) + 40.0*math.Sin(y/3.0*math.Pi)) * 2.0 / 3.0
	latPoly += (160.0*math.Sin(y/12.0*math.Pi) + 320.0*math.Sin(y*math.Pi/30.0)) * 2.0 / 3.0

	lngPoly := 300.0 + x + 2.0*y + 0.1*x*x + 0.1*x*y + 0.1*math.Sqrt(math.Abs(x))
	lngPoly += (20.0*math.Sin(6.0*x*math.Pi) + 20.0*math.Sin(2.0*x*math.Pi)) * 2.0 / 3.0
	lngPoly += (20.0*math.Sin(x*math.Pi) + 40.0*math.Sin(x/3.0*math.Pi)) * 2.0 / 3.0
	lngPoly += (150.0*math.Sin(x/12.0*math.Pi) + 300.0*math.Sin(x/30.0*math.Pi)) * 2.0 / 3.0

	dLat = (latPoly * 180.0) / ((a * (1 - ee)) / (magic * sqrtMagic) * math.Pi)
	dLng = (lngPoly * 180.0) / (a / sqrtMagic * math.Cos(radLat) * math.Pi)
	return dLat, dLng
}

// insideChina is the coarse bbox used by every public implementation of the
// transform; edge precision is irrelevant because the offset vanishes there.
func insideChina(lat, lng float64) bool {
	return lng >= 72.004 && lng <= 137.8347 && lat >= 0.8293 && lat <= 55.8271
}
