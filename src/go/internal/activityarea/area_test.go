package activityarea

import "testing"

func TestInferUsesStrictMajorityCluster(t *testing.T) {
	area := Infer([]Coordinate{
		{Latitude: 31.2304, Longitude: 121.4737},
		{Latitude: 31.2200, Longitude: 121.4800},
		{Latitude: 31.2400, Longitude: 121.4600},
		{Latitude: 39.9042, Longitude: 116.4074},
	})
	if area == nil || area.SupportingActivityCount != 3 {
		t.Fatalf("area = %+v", area)
	}
}

func TestInferStaysUnknownWithoutStrictMajority(t *testing.T) {
	if area := Infer([]Coordinate{
		{Latitude: 31.2304, Longitude: 121.4737},
		{Latitude: 39.9042, Longitude: 116.4074},
		{Latitude: 23.1291, Longitude: 113.2644},
	}); area != nil {
		t.Fatalf("area = %+v, want unknown", area)
	}
}
