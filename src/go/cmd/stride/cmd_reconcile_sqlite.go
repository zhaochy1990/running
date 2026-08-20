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
		var sport, trainKind sql.NullString
		var avgHr, maxHr, calories sql.NullInt64
		var feel, distanceM, durationS, vo2max, temperature sql.NullFloat64
		if err := rows.Scan(&label, &sportType, &sport, &trainKind, &feel,
			&avgHr, &maxHr, &calories, &distanceM, &durationS, &vo2max, &temperature); err != nil {
			return nil, err
		}
		out[label] = map[string]any{
			"sport_type":    niInt(sportType),
			"sport":         nsStr(sport),
			"train_kind":    nsStr(trainKind),
			"feel":          nfFloat(feel),
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

func readSQLiteCalibration(path string) (map[string]map[string]any, error) {
	return querySQLite(path, `SELECT as_of_date, algorithm_version,
		threshold_hr_confidence, threshold_speed_confidence, hrmax_confidence, speed_duration_confidence,
		threshold_hr, threshold_speed_mps, rhr_baseline, observed_max_hr, hrmax_estimate, high_hr_reference,
		critical_power_w, critical_speed_mps, d_prime_m, riegel_k, endurance_index, speed_index
		FROM running_calibration_snapshot`, func(rows *sql.Rows, out map[string]map[string]any) error {
		var asOf, thrConf, spdConf, hrmaxConf, sdConf string
		var alg sql.NullInt64
		var thr, ths, rhr, omax, hmax, href, cpw, cs, dp, rk, ei, si sql.NullFloat64
		if err := rows.Scan(&asOf, &alg, &thrConf, &spdConf, &hrmaxConf, &sdConf,
			&thr, &ths, &rhr, &omax, &hmax, &href, &cpw, &cs, &dp, &rk, &ei, &si); err != nil {
			return err
		}
		out[asOf] = map[string]any{
			"algorithm_version": niInt(alg), "threshold_hr_confidence": thrConf,
			"threshold_speed_confidence": spdConf, "hrmax_confidence": hrmaxConf, "speed_duration_confidence": sdConf,
			"threshold_hr": nfFloat(thr), "threshold_speed_mps": nfFloat(ths), "rhr_baseline": nfFloat(rhr),
			"observed_max_hr": nfFloat(omax), "hrmax_estimate": nfFloat(hmax), "high_hr_reference": nfFloat(href),
			"critical_power_w": nfFloat(cpw), "critical_speed_mps": nfFloat(cs), "d_prime_m": nfFloat(dp),
			"riegel_k": nfFloat(rk), "endurance_index": nfFloat(ei), "speed_index": nfFloat(si),
		}
		return nil
	})
}

func readSQLiteZones(path string) (map[string]map[string]any, error) {
	return querySQLite(path, `SELECT s.as_of_date, z.zone_kind, z.name, z.confidence,
		z.min_value, z.max_value, z.min_speed_mps, z.max_speed_mps
		FROM running_calibration_zone z JOIN running_calibration_snapshot s ON z.snapshot_id = s.id`,
		func(rows *sql.Rows, out map[string]map[string]any) error {
			var asOf, kind, name, conf string
			var minV, maxV, minS, maxS sql.NullFloat64
			if err := rows.Scan(&asOf, &kind, &name, &conf, &minV, &maxV, &minS, &maxS); err != nil {
				return err
			}
			out[asOf+"|"+kind+"|"+name] = map[string]any{
				"confidence": conf, "min_value": nfFloat(minV), "max_value": nfFloat(maxV),
				"min_speed_mps": nfFloat(minS), "max_speed_mps": nfFloat(maxS),
			}
			return nil
		})
}

func readSQLitePBs(path string) (map[string]map[string]any, error) {
	return querySQLite(path, `SELECT distance, source, achieved_at, pb_time_sec FROM personal_bests`,
		func(rows *sql.Rows, out map[string]map[string]any) error {
			var distance string
			var source, achievedAt sql.NullString
			var pb sql.NullFloat64
			if err := rows.Scan(&distance, &source, &achievedAt, &pb); err != nil {
				return err
			}
			out[distance] = map[string]any{"source": nsStr(source), "achieved_at": nsStr(achievedAt), "pb_time_sec": nfFloat(pb)}
			return nil
		})
}

func readSQLiteActivityLoad(path string) (map[string]map[string]any, error) {
	return querySQLite(path, `SELECT label_id, session_class, coverage_status, load_confidence,
		training_dose_source, excluded_from_pmc, training_dose, cardio_tss, external_tss, high_intensity_tss,
		cardio_coverage, external_coverage, high_intensity_coverage FROM activity_training_load`,
		func(rows *sql.Rows, out map[string]map[string]any) error {
			var label, cov string
			var session, conf, src sql.NullString
			var excluded sql.NullInt64
			var dose, cardio, ext, hi, cc, ec, hc sql.NullFloat64
			if err := rows.Scan(&label, &session, &cov, &conf, &src, &excluded, &dose, &cardio, &ext, &hi, &cc, &ec, &hc); err != nil {
				return err
			}
			out[label] = map[string]any{
				"session_class": nsStr(session), "coverage_status": cov, "load_confidence": nsStr(conf),
				"training_dose_source": nsStr(src), "excluded_from_pmc": niInt(excluded),
				"training_dose": nfFloat(dose), "cardio_tss": nfFloat(cardio), "external_tss": nfFloat(ext),
				"high_intensity_tss": nfFloat(hi), "cardio_coverage": nfFloat(cc),
				"external_coverage": nfFloat(ec), "high_intensity_coverage": nfFloat(hc),
			}
			return nil
		})
}

func readSQLiteDailyLoad(path string) (map[string]map[string]any, error) {
	return querySQLite(path, `SELECT date, coverage_status, training_dose, acute_load, chronic_load, form, load_ratio
		FROM daily_training_load`, func(rows *sql.Rows, out map[string]map[string]any) error {
		var date, cov string
		var dose, acute, chronic, form, ratio sql.NullFloat64
		if err := rows.Scan(&date, &cov, &dose, &acute, &chronic, &form, &ratio); err != nil {
			return err
		}
		out[date[:min(10, len(date))]] = map[string]any{
			"coverage_status": cov, "training_dose": nfFloat(dose), "acute_load": nfFloat(acute),
			"chronic_load": nfFloat(chronic), "form": nfFloat(form), "load_ratio": nfFloat(ratio),
		}
		return nil
	})
}

// readSQLiteDashboard reads the dashboard singleton, keyed by provider to match
// the Go ReconcileDashboardRows shape.
func readSQLiteDashboard(path string) (map[string]map[string]any, error) {
	return querySQLite(path, `SELECT provider, running_level, aerobic_score, lactate_threshold_score,
		anaerobic_endurance_score, anaerobic_capacity_score, rhr, threshold_hr, threshold_pace_s_km,
		recovery_pct, avg_sleep_hrv, hrv_normal_low, hrv_normal_high, weekly_distance_m, weekly_duration_s
		FROM dashboard`, func(rows *sql.Rows, out map[string]map[string]any) error {
		var provider string
		var rl, as, lts, aes, acs, tpsk, rp, ash, hnl, hnh, wd, wdur sql.NullFloat64
		var rhr, thr sql.NullInt64
		if err := rows.Scan(&provider, &rl, &as, &lts, &aes, &acs, &rhr, &thr, &tpsk,
			&rp, &ash, &hnl, &hnh, &wd, &wdur); err != nil {
			return err
		}
		out[provider] = map[string]any{
			"running_level": nfFloat(rl), "aerobic_score": nfFloat(as),
			"lactate_threshold_score": nfFloat(lts), "anaerobic_endurance_score": nfFloat(aes),
			"anaerobic_capacity_score": nfFloat(acs), "rhr": niInt(rhr), "threshold_hr": niInt(thr),
			"threshold_pace_s_km": nfFloat(tpsk), "recovery_pct": nfFloat(rp),
			"avg_sleep_hrv": nfFloat(ash), "hrv_normal_low": nfFloat(hnl), "hrv_normal_high": nfFloat(hnh),
			"weekly_distance_m": nfFloat(wd), "weekly_duration_s": nfFloat(wdur),
		}
		return nil
	})
}

// readSQLiteDailyHRV reads daily_hrv rows keyed by date.
func readSQLiteDailyHRV(path string) (map[string]map[string]any, error) {
	return querySQLite(path, `SELECT date, weekly_avg, last_night_avg, last_night_5min_high,
		status, baseline_low_upper, baseline_balanced_low, baseline_balanced_upper, feedback_phrase
		FROM daily_hrv`, func(rows *sql.Rows, out map[string]map[string]any) error {
		var date string
		var wa, lna, l5h, blu, bbl, bbu sql.NullInt64
		var status, phrase sql.NullString
		if err := rows.Scan(&date, &wa, &lna, &l5h, &status, &blu, &bbl, &bbu, &phrase); err != nil {
			return err
		}
		out[date] = map[string]any{
			"weekly_avg": niInt(wa), "last_night_avg": niInt(lna), "last_night_5min_high": niInt(l5h),
			"status": nsStr(status), "baseline_low_upper": niInt(blu),
			"baseline_balanced_low": niInt(bbl), "baseline_balanced_upper": niInt(bbu),
			"feedback_phrase": nsStr(phrase),
		}
		return nil
	})
}

// readSQLiteRacePredictions reads race_predictions rows keyed by race_type.
func readSQLiteRacePredictions(path string) (map[string]map[string]any, error) {
	return querySQLite(path, `SELECT race_type, duration_s, avg_pace FROM race_predictions`,
		func(rows *sql.Rows, out map[string]map[string]any) error {
			var raceType string
			var dur, pace sql.NullFloat64
			if err := rows.Scan(&raceType, &dur, &pace); err != nil {
				return err
			}
			out[raceType] = map[string]any{"duration_s": nfFloat(dur), "avg_pace": nfFloat(pace)}
			return nil
		})
}

func querySQLite(path, query string, scan func(*sql.Rows, map[string]map[string]any) error) (map[string]map[string]any, error) {
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, err
	}
	defer db.Close()
	rows, err := db.Query(query)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]map[string]any{}
	for rows.Next() {
		if err := scan(rows, out); err != nil {
			return nil, err
		}
	}
	return out, rows.Err()
}
