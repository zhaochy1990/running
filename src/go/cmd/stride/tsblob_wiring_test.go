// tsblob_wiring_test.go guards the devops#786 regression found by the epic-783
// E2E round: running#639 shipped cmd_api.go building the ts-blob backend and
// dropping it on the floor (`_ = tsBlobStore`), so the API's detail reads
// silently stayed on rows while the worker's switched. Both long-running
// entrypoints (api, worker) must inject the backend they build into the store
// they serve from. Source-scan rather than boot-and-check because the
// entrypoints need live MySQL/AMQP/COS to run; the storage-level behaviour
// after injection (blob-served reads, row fallback, LRU) is covered by
// internal/storage/tsread_test.go.
package main

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestTSBlobStoreInjectedByEveryEntrypoint(t *testing.T) {
	_, source, _, _ := runtime.Caller(0)
	for _, file := range []string{"cmd_api.go", "cmd_worker.go"} {
		raw, err := os.ReadFile(filepath.Join(filepath.Dir(source), file))
		if err != nil {
			t.Fatalf("read %s: %v", file, err)
		}
		src := string(raw)
		if !strings.Contains(src, "store.SetTSBlobStore(") {
			t.Errorf("%s: builds a ts-blob backend but never injects it into the store — api reads stay on rows (devops#786); add store.SetTSBlobStore(...)", file)
		}
		if strings.Contains(src, "_ = tsBlobStore") {
			t.Errorf("%s: tsBlobStore built then discarded (`_ = tsBlobStore`) — the devops#786 regression shape; inject it instead", file)
		}
	}
}
