package main

import (
	"database/sql"

	_ "modernc.org/sqlite"
)

// readSQLite reads the Python coros.db activities table into the generic row
// shape the diff engine consumes, matching storage.ReconcileActivityRows. Uses
// the pure-Go modernc.org/sqlite driver (no cgo). When provider is non-empty the
// SQLite side is filtered to that provider too, so a mixed-provider DB reconciles
// one provider at a time.
func readSQLite(path string, provider string) (map[string]map[string]any, error) {
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, err
	}
	defer db.Close()

	query := `SELECT label_id, sport_type, sport, train_kind, feel,
		avg_hr, max_hr, calories_kcal, distance_m, duration_s, vo2max, temperature
		FROM activities`
	var args []any
	if provider != "" {
		query += " WHERE provider = ?"
		args = append(args, provider)
	}
	rows, err := db.Query(query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := map[string]map[string]any{}
	for rows.Next() {
		var label string
		var sportType sql.NullInt64
		var sport, trainKind, feel sql.NullString
		var avgHr, maxHr, calories sql.NullInt64
		var distanceM, durationS, vo2max, temperature sql.NullFloat64
		if err := rows.Scan(&label, &sportType, &sport, &trainKind, &feel,
			&avgHr, &maxHr, &calories, &distanceM, &durationS, &vo2max, &temperature); err != nil {
			return nil, err
		}
		out[label] = map[string]any{
			"sport_type":    niInt(sportType),
			"sport":         nsStr(sport),
			"train_kind":    nsStr(trainKind),
			"feel":          nsStr(feel),
			"avg_hr":        niInt(avgHr),
			"max_hr":        niInt(maxHr),
			"calories_kcal": niInt(calories),
			"distance_m":    nfFloat(distanceM),
			"duration_s":    nfFloat(durationS),
			"vo2max":        nfFloat(vo2max),
			"temperature":   nfFloat(temperature),
		}
	}
	return out, rows.Err()
}

func nsStr(v sql.NullString) any {
	if !v.Valid {
		return nil
	}
	return v.String
}
func niInt(v sql.NullInt64) any {
	if !v.Valid {
		return nil
	}
	return v.Int64
}
func nfFloat(v sql.NullFloat64) any {
	if !v.Valid {
		return nil
	}
	return v.Float64
}
