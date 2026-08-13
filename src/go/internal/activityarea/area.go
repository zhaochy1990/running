// Package activityarea derives a user's usual activity area from historical
// activity starts. It deliberately models an imprecise activity cluster, not a
// home address.
package activityarea

import "math"

// Coordinate is one activity's first valid GPS point.
type Coordinate struct {
	Latitude  float64
	Longitude float64
}

// Area is the majority cluster of historical activity starts.
type Area struct {
	Latitude                float64
	Longitude               float64
	SupportingActivityCount int
}

// Snapshot is one persisted computation. Area is nil when there was not enough
// evidence to identify a strict majority cluster.
type Snapshot struct {
	Computed bool
	Area     *Area
}

const RadiusKM = 50.0

// Infer returns a majority cluster only when at least three valid starts and a
// strict majority of all valid starts fall within RadiusKM of one another.
func Infer(starts []Coordinate) *Area {
	valid := make([]Coordinate, 0, len(starts))
	for _, start := range starts {
		if validCoordinate(start.Latitude, start.Longitude) {
			valid = append(valid, start)
		}
	}
	if len(valid) < 3 {
		return nil
	}
	best := []Coordinate(nil)
	for _, center := range valid {
		cluster := make([]Coordinate, 0, len(valid))
		for _, point := range valid {
			if DistanceKM(center, point) <= RadiusKM {
				cluster = append(cluster, point)
			}
		}
		if len(cluster) > len(best) {
			best = cluster
		}
	}
	if len(best) < 3 || len(best)*2 <= len(valid) {
		return nil
	}
	var latitude, longitude float64
	for _, point := range best {
		latitude += point.Latitude
		longitude += point.Longitude
	}
	return &Area{
		Latitude: latitude / float64(len(best)), Longitude: longitude / float64(len(best)),
		SupportingActivityCount: len(best),
	}
}

func validCoordinate(latitude, longitude float64) bool {
	return latitude >= -90 && latitude <= 90 && longitude >= -180 && longitude <= 180 && (latitude != 0 || longitude != 0)
}

// DistanceKM returns the great-circle distance between two coordinates.
func DistanceKM(a, b Coordinate) float64 {
	const earthRadiusKM = 6371.0088
	lat1 := a.Latitude * math.Pi / 180
	lat2 := b.Latitude * math.Pi / 180
	deltaLat := (b.Latitude - a.Latitude) * math.Pi / 180
	deltaLon := (b.Longitude - a.Longitude) * math.Pi / 180
	h := math.Sin(deltaLat/2)*math.Sin(deltaLat/2) + math.Cos(lat1)*math.Cos(lat2)*math.Sin(deltaLon/2)*math.Sin(deltaLon/2)
	return earthRadiusKM * 2 * math.Atan2(math.Sqrt(h), math.Sqrt(1-h))
}
