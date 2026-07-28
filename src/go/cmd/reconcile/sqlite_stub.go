//go:build !sqlite

package main

import "errors"

// readSQLite is the default stub. The real reader needs a SQLite driver
// (modernc.org/sqlite, pure-Go, no cgo) that is not yet a module dependency
// because it could not be fetched offline. Once added, provide a build-tagged
// implementation (//go:build sqlite) that SELECTs the same columns as
// storage.ReconcileActivityRows from the Python coros.db — keyed by label_id,
// with date/JSON normalized to the MySQL shapes — and build with `-tags sqlite`.
func readSQLite(_ string, _ string) (map[string]map[string]any, error) {
	return nil, errors.New("SQLite reader not built (add modernc.org/sqlite, then build with -tags sqlite)")
}
