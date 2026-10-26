// codec.go is the shared blob format for all three Store backends (design
// timeseries-blob-migration §3): a gzip-compressed JSON envelope, versioned v1.
//
// SHA256 covers the uncompressed JSON encoding of the points array — the exact
// bytes json.Marshal produced at encode time — so corruption is detectable
// after transport through any backend, and the value stored on the activity
// row (ts_sha256) can be re-verified independently of gzip.
package tsstore

import (
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
)

// blobVersion is the envelope version this codec writes and accepts.
const blobVersion = 1

// Point is one sampled timeseries point — a local mirror of
// storage.TimeseriesPoint's data columns (all nullable → pointers), NOT an
// import: Phase 1 injects tsstore into the storage write path, so the
// dependency may only point the other way (see the package comment).
//
// JSON keys are short and omitempty: the points array dominates the blob, and
// most columns are NULL on any given point, so dropped keys are most of the
// win. The 16 data columns of the row (including the six write-only running
// dynamics channels gct/vosc/vratio/cdl/slope/hlvl, which no Go reader touches
// but a resync must not lose) are all preserved.
type Point struct {
	Ts     *int64   `json:"ts,omitempty"`     // timestamp
	Dist   *float64 `json:"dist,omitempty"`   // distance (m)
	Hr     *int     `json:"hr,omitempty"`     // heart_rate
	Spd    *float64 `json:"spd,omitempty"`    // speed
	Pace   *float64 `json:"pace,omitempty"`   // adjusted_pace
	Cad    *int     `json:"cad,omitempty"`    // cadence
	Alt    *float64 `json:"alt,omitempty"`    // altitude
	Pwr    *int     `json:"pwr,omitempty"`    // power
	Gct    *float64 `json:"gct,omitempty"`    // ground_contact_time_ms
	Vosc   *float64 `json:"vosc,omitempty"`   // vertical_oscillation_mm
	Vratio *float64 `json:"vratio,omitempty"` // vertical_ratio_pct
	Cdl    *float64 `json:"cdl,omitempty"`    // cadence_length_cm
	Slope  *int     `json:"slope,omitempty"`  // slope
	Hlvl   *int     `json:"hlvl,omitempty"`   // heart_level
	Lat    *float64 `json:"lat,omitempty"`    // gps_lat
	Lon    *float64 `json:"lon,omitempty"`    // gps_lon
}

// blobV1 is the JSON envelope inside the gzip stream.
type blobV1 struct {
	V          int     `json:"v"`
	UserID     string  `json:"user_id"`
	LabelID    string  `json:"label_id"`
	PointCount int     `json:"point_count"`
	SHA256     string  `json:"sha256"`
	Points     []Point `json:"points"`
}

// Blob is the decoded form of a timeseries blob.
type Blob struct {
	UserID     string
	LabelID    string
	PointCount int
	Points     []Point
}

// EncodePoints serialises one activity's points into the v1 gzip blob (the
// exact bytes Put stores under BlobKey(userID, labelID)). A nil/empty slice
// encodes as a zero-point blob — an activity without samples is representable.
func EncodePoints(userID, labelID string, points []Point) ([]byte, error) {
	if points == nil {
		points = []Point{} // normalise so the checksum bytes are "[]", never "null"
	}
	body, err := json.Marshal(points)
	if err != nil {
		return nil, fmt.Errorf("tsstore: marshal points: %w", err)
	}
	sum := sha256.Sum256(body)
	blob := blobV1{
		V: blobVersion, UserID: userID, LabelID: labelID,
		PointCount: len(points), SHA256: hex.EncodeToString(sum[:]),
		Points: points,
	}
	raw, err := json.Marshal(blob)
	if err != nil {
		return nil, fmt.Errorf("tsstore: marshal blob: %w", err)
	}
	var buf bytes.Buffer
	gw := gzip.NewWriter(&buf)
	if _, err := gw.Write(raw); err != nil {
		return nil, fmt.Errorf("tsstore: gzip blob: %w", err)
	}
	if err := gw.Close(); err != nil {
		return nil, fmt.Errorf("tsstore: close gzip: %w", err)
	}
	return buf.Bytes(), nil
}

// DecodePoints reverses EncodePoints. It verifies the envelope version, the
// points-JSON checksum, and the point count, so any silent corruption (or a
// future format change) surfaces as an explicit error instead of wrong data.
// json.Marshal of a struct slice is deterministic (declaration order, shortest
// float form), so re-marshalling the decoded points must reproduce the
// checksummed bytes exactly.
func DecodePoints(payload []byte) (Blob, error) {
	gr, err := gzip.NewReader(bytes.NewReader(payload))
	if err != nil {
		return Blob{}, fmt.Errorf("tsstore: gunzip blob: %w", err)
	}
	raw, err := io.ReadAll(gr)
	closeErr := gr.Close()
	if err != nil {
		return Blob{}, fmt.Errorf("tsstore: read blob: %w", err)
	}
	if closeErr != nil {
		return Blob{}, fmt.Errorf("tsstore: close gunzip: %w", closeErr)
	}
	var blob blobV1
	if err := json.Unmarshal(raw, &blob); err != nil {
		return Blob{}, fmt.Errorf("tsstore: unmarshal blob: %w", err)
	}
	if blob.V != blobVersion {
		return Blob{}, fmt.Errorf("tsstore: unsupported blob version %d (want %d)", blob.V, blobVersion)
	}
	if blob.Points == nil {
		blob.Points = []Point{}
	}
	body, err := json.Marshal(blob.Points)
	if err != nil {
		return Blob{}, fmt.Errorf("tsstore: recheck points: %w", err)
	}
	sum := sha256.Sum256(body)
	if got := hex.EncodeToString(sum[:]); got != blob.SHA256 {
		return Blob{}, fmt.Errorf("tsstore: blob checksum mismatch for %s/%s: decoded %s, blob says %s",
			blob.UserID, blob.LabelID, got, blob.SHA256)
	}
	if blob.PointCount != len(blob.Points) {
		return Blob{}, fmt.Errorf("tsstore: point count mismatch for %s/%s: blob says %d, points has %d",
			blob.UserID, blob.LabelID, blob.PointCount, len(blob.Points))
	}
	return Blob{UserID: blob.UserID, LabelID: blob.LabelID, PointCount: blob.PointCount, Points: blob.Points}, nil
}
