// reconcile_reader.go exposes activity rows in the generic shape the reconcile
// diff engine consumes (label_id → {column → value}), with nullable columns as
// nil. Used by cmd/reconcile to read the MySQL (Go-written) side.
package storage

import "context"

// ReconcileActivityRows returns the user's activities keyed by label_id, with a
// column subset comparable to the SQLite store. Nullable columns are nil when
// absent (so the diff engine can compare nullability).
func (s *Store) ReconcileActivityRows(ctx context.Context, userID string) (map[string]map[string]any, error) {
	return s.reconcileActivityRows(ctx, userID, "")
}

// ReconcileActivityRowsByProvider is ReconcileActivityRows filtered to one
// provider — used to reconcile a single provider's shadow rows (e.g. garmin)
// without mixing in another provider's activities for the same user.
func (s *Store) ReconcileActivityRowsByProvider(ctx context.Context, userID, provider string) (map[string]map[string]any, error) {
	return s.reconcileActivityRows(ctx, userID, provider)
}

func (s *Store) reconcileActivityRows(ctx context.Context, userID, provider string) (map[string]map[string]any, error) {
	uid, err := canonicalUserID(userID)
	if err != nil {
		return nil, err
	}
	q := s.db.WithContext(ctx).Where("user_id = ?", uid)
	if provider != "" {
		q = q.Where("provider = ?", provider)
	}
	var rows []Activity
	if err := q.Find(&rows).Error; err != nil {
		return nil, err
	}
	out := make(map[string]map[string]any, len(rows))
	for i := range rows {
		a := rows[i]
		out[a.LabelID] = map[string]any{
			"sport_type":    a.SportType,
			"sport":         anyStr(a.Sport),
			"train_kind":    anyStr(a.TrainKind),
			"feel":          anyFloat(a.Feel),
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

func anyBool(b bool) any {
	if b {
		return int64(1)
	}
	return int64(0)
}

// ReconcileCalibrationRows returns running_calibration_snapshot rows keyed by
// as_of_date.
func (s *Store) ReconcileCalibrationRows(ctx context.Context, userID string) (map[string]map[string]any, error) {
	uid, err := canonicalUserID(userID)
	if err != nil {
		return nil, err
	}
	var rows []RunningCalibrationSnapshot
	if err := s.db.WithContext(ctx).Where("user_id = ?", uid).Find(&rows).Error; err != nil {
		return nil, err
	}
	out := make(map[string]map[string]any, len(rows))
	for i := range rows {
		r := rows[i]
		out[r.AsOfDate] = map[string]any{
			"algorithm_version":          int64(r.AlgorithmVersion),
			"threshold_hr_confidence":    r.ThresholdHRConfidence,
			"threshold_speed_confidence": r.ThresholdSpeedConfidence,
			"hrmax_confidence":           r.HRMaxConfidence,
			"speed_duration_confidence":  r.SpeedDurationConfidence,
			"threshold_hr":               anyFloat(r.ThresholdHR),
			"threshold_speed_mps":        anyFloat(r.ThresholdSpeedMps),
			"rhr_baseline":               anyFloat(r.RHRBaseline),
			"observed_max_hr":            anyFloat(r.ObservedMaxHR),
			"hrmax_estimate":             anyFloat(r.HRMaxEstimate),
			"high_hr_reference":          anyFloat(r.HighHRReference),
			"critical_power_w":           anyFloat(r.CriticalPowerW),
			"critical_speed_mps":         anyFloat(r.CriticalSpeedMps),
			"d_prime_m":                  anyFloat(r.DPrimeM),
			"riegel_k":                   anyFloat(r.RiegelK),
			"endurance_index":            anyFloat(r.EnduranceIndex),
			"speed_index":                anyFloat(r.SpeedIndex),
		}
	}
	return out, nil
}

// ReconcileZoneRows returns the calibration zone rows keyed by
// as_of_date|zone_kind|name. Pace and HR zones live in separate tables
// (running_calibration_pace_zone / running_calibration_hr_zone); this projects
// both back into the shared zone_kind|min_value|max_value comparison shape so
// the diff still lines up against the Python single-table store.
func (s *Store) ReconcileZoneRows(ctx context.Context, userID string) (map[string]map[string]any, error) {
	uid, err := canonicalUserID(userID)
	if err != nil {
		return nil, err
	}
	var snaps []RunningCalibrationSnapshot
	if err := s.db.WithContext(ctx).Where("user_id = ?", uid).Find(&snaps).Error; err != nil {
		return nil, err
	}
	asOfByID := map[uint64]string{}
	for i := range snaps {
		asOfByID[snaps[i].ID] = snaps[i].AsOfDate
	}

	var paceRows []RunningCalibrationPaceZone
	if err := s.db.WithContext(ctx).Where("user_id = ?", uid).Find(&paceRows).Error; err != nil {
		return nil, err
	}
	var hrRows []RunningCalibrationHRZone
	if err := s.db.WithContext(ctx).Where("user_id = ?", uid).Find(&hrRows).Error; err != nil {
		return nil, err
	}

	out := make(map[string]map[string]any, len(paceRows)+len(hrRows))
	for i := range paceRows {
		r := paceRows[i]
		asOf, ok := asOfByID[r.SnapshotID]
		if !ok {
			continue
		}
		out[asOf+"|pace|"+r.Name] = map[string]any{
			"confidence":    r.Confidence,
			"min_value":     anyFloat(r.MinPaceSPerKm),
			"max_value":     anyFloat(r.MaxPaceSPerKm),
			"min_speed_mps": anyFloat(r.MinSpeedMps),
			"max_speed_mps": anyFloat(r.MaxSpeedMps),
		}
	}
	for i := range hrRows {
		r := hrRows[i]
		asOf, ok := asOfByID[r.SnapshotID]
		if !ok {
			continue
		}
		out[asOf+"|heart_rate|"+r.Name] = map[string]any{
			"confidence":    r.Confidence,
			"min_value":     anyFloat(r.MinBpm),
			"max_value":     anyFloat(r.MaxBpm),
			"min_speed_mps": nil,
			"max_speed_mps": nil,
		}
	}
	return out, nil
}

// ReconcilePersonalBestRows returns personal_bests rows keyed by distance.
func (s *Store) ReconcilePersonalBestRows(ctx context.Context, userID string) (map[string]map[string]any, error) {
	uid, err := canonicalUserID(userID)
	if err != nil {
		return nil, err
	}
	var rows []PersonalBest
	if err := s.db.WithContext(ctx).Where("user_id = ?", uid).Find(&rows).Error; err != nil {
		return nil, err
	}
	out := make(map[string]map[string]any, len(rows))
	for i := range rows {
		r := rows[i]
		out[r.Distance] = map[string]any{
			"source":      anyStr(r.Source),
			"achieved_at": anyStr(r.AchievedAt),
			"pb_time_sec": r.PBTimeSec,
		}
	}
	return out, nil
}

// ReconcileActivityLoadRows returns activity_training_load rows keyed by label_id.
func (s *Store) ReconcileActivityLoadRows(ctx context.Context, userID string) (map[string]map[string]any, error) {
	uid, err := canonicalUserID(userID)
	if err != nil {
		return nil, err
	}
	var rows []ActivityTrainingLoad
	if err := s.db.WithContext(ctx).Where("user_id = ?", uid).Find(&rows).Error; err != nil {
		return nil, err
	}
	out := make(map[string]map[string]any, len(rows))
	for i := range rows {
		r := rows[i]
		out[r.LabelID] = map[string]any{
			"session_class":           anyStr(r.SessionClass),
			"coverage_status":         r.CoverageStatus,
			"load_confidence":         anyStr(r.LoadConfidence),
			"training_dose_source":    anyStr(r.TrainingDoseSource),
			"excluded_from_pmc":       anyBool(r.ExcludedFromPMC),
			"training_dose":           anyFloat(r.TrainingDose),
			"cardio_tss":              anyFloat(r.CardioTSS),
			"external_tss":            anyFloat(r.ExternalTSS),
			"high_intensity_tss":      anyFloat(r.HighIntensityTSS),
			"cardio_coverage":         r.CardioCoverage,
			"external_coverage":       r.ExternalCoverage,
			"high_intensity_coverage": r.HighIntensityCoverage,
		}
	}
	return out, nil
}

// ReconcileDailyLoadRows returns daily_training_load rows keyed by date.
func (s *Store) ReconcileDailyLoadRows(ctx context.Context, userID string) (map[string]map[string]any, error) {
	uid, err := canonicalUserID(userID)
	if err != nil {
		return nil, err
	}
	var rows []DailyTrainingLoad
	if err := s.db.WithContext(ctx).Where("user_id = ?", uid).Find(&rows).Error; err != nil {
		return nil, err
	}
	out := make(map[string]map[string]any, len(rows))
	for i := range rows {
		r := rows[i]
		out[r.Date] = map[string]any{
			"coverage_status": r.CoverageStatus,
			"training_dose":   r.TrainingDose,
			"acute_load":      r.AcuteLoad,
			"chronic_load":    r.ChronicLoad,
			"form":            r.Form,
			"load_ratio":      anyFloat(r.LoadRatio),
		}
	}
	return out, nil
}
