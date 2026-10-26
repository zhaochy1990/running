package tsstore

import (
	"bytes"
	"compress/gzip"
	"encoding/json"
	"reflect"
	"testing"
)

func i64(v int64) *int64     { return &v }
func f64(v float64) *float64 { return &v }
func ii(v int) *int          { return &v }

// fixturePoints returns two fully-populated points: every data column set,
// including the six write-only running dynamics channels no Go reader touches.
func fixturePoints() []Point {
	return []Point{
		{
			Ts: i64(1761400000), Dist: f64(1000.5), Hr: ii(150), Spd: f64(2.9),
			Pace: f64(345.6), Cad: ii(180), Alt: f64(12.3), Pwr: ii(210),
			Gct: f64(245), Vosc: f64(8.9), Vratio: f64(6.1), Cdl: f64(105.2),
			Slope: ii(2), Hlvl: ii(3), Lat: f64(31.13), Lon: f64(121.4),
		},
		{
			Ts: i64(1761400010), Dist: f64(1029.9), Hr: ii(151), Spd: f64(2.9),
			Pace: f64(344.1), Cad: ii(182), Alt: f64(12.1), Pwr: ii(212),
			Gct: f64(244), Vosc: f64(9.1), Vratio: f64(6.0), Cdl: f64(104.8),
			Slope: ii(1), Hlvl: ii(3), Lat: f64(31.131), Lon: f64(121.401),
		},
	}
}

func mustEncode(t *testing.T, userID, labelID string, points []Point) []byte {
	t.Helper()
	payload, _, err := EncodePoints(userID, labelID, points)
	if err != nil {
		t.Fatalf("EncodePoints: %v", err)
	}
	return payload
}

func TestEncodeDecode_RoundTrip(t *testing.T) {
	const userID, labelID = "6f9619ff-8b86-d011-b42d-00cf4fc964ff", "coros-abc123"
	payload := mustEncode(t, userID, labelID, fixturePoints())

	if payload[0] != 0x1f || payload[1] != 0x8b {
		t.Fatalf("payload is not gzip (magic %x %x)", payload[0], payload[1])
	}
	blob, err := DecodePoints(payload)
	if err != nil {
		t.Fatalf("DecodePoints: %v", err)
	}
	if blob.UserID != userID || blob.LabelID != labelID {
		t.Errorf("metadata = %s/%s, want %s/%s", blob.UserID, blob.LabelID, userID, labelID)
	}
	if blob.PointCount != 2 || len(blob.Points) != 2 {
		t.Fatalf("count = %d/%d, want 2/2", blob.PointCount, len(blob.Points))
	}
	want := fixturePoints()
	if !reflect.DeepEqual(blob.Points, want) {
		t.Errorf("points = %+v, want %+v", blob.Points, want)
	}
}

func TestEncodeDecode_EmptyPoints(t *testing.T) {
	payload := mustEncode(t, "u", "l", nil)
	blob, err := DecodePoints(payload)
	if err != nil {
		t.Fatalf("DecodePoints(empty): %v", err)
	}
	if blob.PointCount != 0 || len(blob.Points) != 0 {
		t.Errorf("empty round-trip = %d points, want 0", len(blob.Points))
	}

	payload = mustEncode(t, "u", "l", []Point{})
	if blob, err := DecodePoints(payload); err != nil || len(blob.Points) != 0 {
		t.Errorf("explicit empty slice: err=%v points=%d, want nil/0", err, len(blob.Points))
	}
}

func TestEncodeDecode_AllNullColumns(t *testing.T) {
	// Every data column NULL (an indoor or sparse sample): nothing may be
	// invented, nothing lost.
	payload := mustEncode(t, "u", "l", []Point{{}, {}})
	blob, err := DecodePoints(payload)
	if err != nil {
		t.Fatalf("DecodePoints(all-null): %v", err)
	}
	for i, p := range blob.Points {
		if p != (Point{}) {
			t.Errorf("point %d = %+v, want zero value", i, p)
		}
	}
}

// rewriteBlob ungzip→unmarshal→mutate→remarshal→regzip, the harness for the
// corruption tests below.
func rewriteBlob(t *testing.T, payload []byte, mutate func(*blobV1)) []byte {
	t.Helper()
	gr, err := gzip.NewReader(bytes.NewReader(payload))
	if err != nil {
		t.Fatalf("gunzip: %v", err)
	}
	var raw bytes.Buffer
	if _, err := raw.ReadFrom(gr); err != nil {
		t.Fatalf("read gunzip: %v", err)
	}
	gr.Close()
	var blob blobV1
	if err := json.Unmarshal(raw.Bytes(), &blob); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	mutate(&blob)
	out, err := json.Marshal(blob)
	if err != nil {
		t.Fatalf("remarshal: %v", err)
	}
	var buf bytes.Buffer
	gw := gzip.NewWriter(&buf)
	gw.Write(out)
	gw.Close()
	return buf.Bytes()
}

func TestDecode_PointsChecksumMismatch(t *testing.T) {
	// Tamper the payload's points while keeping the stored checksum: decode
	// must fail on the sha256 verification, not hand back wrong data.
	bad := rewriteBlob(t, mustEncode(t, "u", "l", fixturePoints()), func(b *blobV1) {
		b.Points[0].Hr = ii(999)
	})
	if _, err := DecodePoints(bad); err == nil {
		t.Fatal("tampered points decoded without error")
	}
}

func TestDecode_PointCountMismatch(t *testing.T) {
	// Metadata drift: point_count disagrees with the array. The checksum still
	// matches (it covers only the points JSON), so the count check is what
	// catches it.
	bad := rewriteBlob(t, mustEncode(t, "u", "l", fixturePoints()), func(b *blobV1) {
		b.PointCount = 3
	})
	if _, err := DecodePoints(bad); err == nil {
		t.Fatal("drifted point_count decoded without error")
	}
}

func TestDecode_UnsupportedVersion(t *testing.T) {
	bad := rewriteBlob(t, mustEncode(t, "u", "l", fixturePoints()), func(b *blobV1) {
		b.V = 2
	})
	if _, err := DecodePoints(bad); err == nil {
		t.Fatal("v2 blob decoded without error")
	}
}

func TestDecode_Garbage(t *testing.T) {
	if _, err := DecodePoints([]byte("not gzip at all")); err == nil {
		t.Fatal("garbage decoded without error")
	}
	var buf bytes.Buffer
	gw := gzip.NewWriter(&buf)
	gw.Write([]byte("}{ truncated"))
	gw.Close()
	if _, err := DecodePoints(buf.Bytes()); err == nil {
		t.Fatal("gzip-wrapped garbage decoded without error")
	}
}

func TestBlobKey_Format(t *testing.T) {
	key := BlobKey("user-1", "label-2")
	if key != "ts/v1/user-1/label-2.json.gz" {
		t.Fatalf("BlobKey = %q", key)
	}
}

// TestEncodePoints_SumMatchesDecode: the sha EncodePoints returns must equal
// the checksum inside the decoded blob (it is what activities.ts_sha256
// stores, so the two can never drift).
func TestEncodePoints_SumMatchesDecode(t *testing.T) {
	_, sum, err := EncodePoints("u", "l", fixturePoints())
	if err != nil {
		t.Fatalf("EncodePoints: %v", err)
	}
	if len(sum) != 64 {
		t.Fatalf("sum = %q, want 64 hex chars", sum)
	}
	blob, err := DecodePoints(mustEncode(t, "u", "l", fixturePoints()))
	if err != nil {
		t.Fatalf("DecodePoints: %v", err)
	}
	if blob.SHA256 != sum {
		t.Fatalf("Blob.SHA256 = %s, EncodePoints sum = %s", blob.SHA256, sum)
	}
}

func TestParseBlobKey(t *testing.T) {
	u, l, ok := ParseBlobKey(BlobKey("user-1", "label-2"))
	if !ok || u != "user-1" || l != "label-2" {
		t.Fatalf("ParseBlobKey(BlobKey) = %q %q %v, want user-1 label-2 true", u, l, ok)
	}
	for _, bad := range []string{
		"", "ts/v1/", "ts/v1/only-user", "ts/v1/u/", "ts/v1//l.json.gz",
		"ts/v1/u/l.txt", "other/v1/u/l.json.gz", "ts/v1/u/a/b.json.gz",
	} {
		if _, _, ok := ParseBlobKey(bad); ok {
			t.Errorf("ParseBlobKey(%q) = ok, want rejected", bad)
		}
	}
}
