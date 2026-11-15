package calibration

import (
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"io"
	"sort"
)

// These source files are the time-limited, frozen v3 migration implementation.
// Candidate fixes must not modify them. T6 owns removal after controlled cutover.
//
//go:embed core.go segments.go estimators.go prediction.go mathutil.go zones.go types.go
var frozenV3Sources embed.FS

// FrozenV3SourceSHA256 identifies the actual compiled baseline, including shared
// helpers, so an accidental v3 edit cannot silently masquerade as a candidate fix.
func FrozenV3SourceSHA256() string {
	entries, _ := frozenV3Sources.ReadDir(".")
	names := make([]string, 0, len(entries))
	for _, entry := range entries {
		names = append(names, entry.Name())
	}
	sort.Strings(names)
	hash := sha256.New()
	for _, name := range names {
		io.WriteString(hash, name+"\x00")
		data, _ := frozenV3Sources.ReadFile(name)
		hash.Write(data)
	}
	return hex.EncodeToString(hash.Sum(nil))
}
