// reconcile_reader.go exposes activity rows in the generic shape the reconcile
// diff engine consumes (label_id → {column → value}), with nullable columns as
// nil. Used by cmd/reconcile to read the MySQL (Go-written) side.
package storage

import "context"

// ReconcileActivityRows returns the user's activities keyed by label_id, with a
// column subset comparable to the SQLite store. Nullable columns are nil when
// absent (so the diff engine can compare nullability).
func (s *Store) ReconcileActivityRows(ctx context.Context, userID string) (map[string]map[string]any, error) {
	uid, err := canonicalUserID(userID)
	if err != nil {
		return nil, err
	}
	var rows []Activity
	if err := s.db.WithContext(ctx).Where("user_id = ?", uid).Find(&rows).Error; err != nil {
		return nil, err
	}
	out := make(map[string]map[string]any, len(rows))
	for i := range rows {
		a := rows[i]
		out[a.LabelID] = map[string]any{
			"sport_type":    a.SportType,
			"sport":         anyStr(a.Sport),
			"train_kind":    anyStr(a.TrainKind),
			"feel":          anyStr(a.Feel),
			"avg_hr":        anyInt(a.AvgHR),
			"max_hr":        anyInt(a.MaxHR),
			"calories_kcal": anyInt(a.CaloriesKcal),
			"distance_m":    anyFloat(a.DistanceM),
			"duration_s":    anyFloat(a.DurationS),
			"vo2max":        anyFloat(a.VO2Max),
			"temperature":   anyFloat(a.Temperature),
		}
	}
	return out, nil
}

func anyStr(p *string) any {
	if p == nil {
		return nil
	}
	return *p
}
func anyInt(p *int) any {
	if p == nil {
		return nil
	}
	return int64(*p)
}
func anyFloat(p *float64) any {
	if p == nil {
		return nil
	}
	return *p
}
