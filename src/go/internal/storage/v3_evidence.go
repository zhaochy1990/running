package storage

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/json"
	"fmt"
	"time"

	"github.com/zhaochy1990/stride/internal/compute/calibration"
	"github.com/zhaochy1990/stride/internal/utils/timefmt"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

// Rebuildable, user-scoped v3 evidence. The authoritative activities select
// membership and order; a cache row can never introduce an activity.
type V3CalibrationEvidence struct {
	UserID      string `gorm:"type:char(36);primaryKey"`
	LabelID     string `gorm:"type:varchar(191);primaryKey"`
	InputHash   []byte `gorm:"type:binary(32);not null"`
	Payload     []byte `gorm:"type:longblob;not null"`
	ActivityDay string `gorm:"type:date;not null"`
	// A concurrent account/activity deletion must also erase derived evidence.
	Activity *Activity `gorm:"belongsTo:Activity;foreignKey:UserID,LabelID;references:UserID,LabelID;constraint:OnDelete:CASCADE"`
}

func (V3CalibrationEvidence) TableName() string { return "running_calibration_v3_evidence" }

type v3InputRow struct {
	Activity           `gorm:"embedded"`
	LastLap            uint64
	InputHash, Payload []byte
}

// Changed laps are replaced with fresh IDs; identical re-deliveries keep their
// IDs (replaceActivityLaps, shared by both watch writers). Their MAX(id) detects a lap-only replacement,
// including a transition to an empty collection. Other source fields and the
// verified blob identity are taken from the same repeatable-read view.
func (r *v3InputRow) signature(format int) ([]byte, error) {
	// Older partial pointers can be read, but the blob's contents have no
	// authoritative revision to key persistent reuse on.
	if r.TsBlobKey != nil && *r.TsBlobKey != "" && (r.TsSHA256 == nil || *r.TsSHA256 == "") {
		return nil, nil
	}
	raw, err := json.Marshal([]any{
		format, r.LabelID, r.Date, r.Sport, r.SportType,
		r.DistanceM, r.DurationS, r.AvgHR, r.MaxHR, r.AvgPower,
		r.TsBlobKey, r.TsPointCount, r.TsSHA256, r.LastLap,
	})
	if err != nil {
		return nil, err
	}
	sum := sha256.Sum256(raw)
	return sum[:], nil
}

type V3EvidenceVisitor struct {
	Running func(Activity) bool
	// Return false for a miss or an unreadable/obsolete payload.
	Reuse func([]byte) bool
	Build func(Activity, []TimeseriesPoint, []Lap) ([]byte, error)
}

func (s *Store) VisitV3CalibrationWindow(ctx context.Context, user string, start, end time.Time, format int, visit V3EvidenceVisitor) ([]DailyHealth, error) {
	uid, err := canonicalUserID(user)
	if err != nil {
		return nil, err
	}
	var health []DailyHealth
	err = s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var rows []v3InputRow
		// Keep the order (including same-day ties) of ActivitiesInWindow.
		err := tx.Table("activities AS a").
			Select(`a.label_id, a.date, a.sport, a.sport_type, a.distance_m, a.duration_s,
                    a.avg_hr, a.max_hr, a.avg_power, a.ts_blob_key, a.ts_point_count, a.ts_sha256,
                    COALESCE((SELECT MAX(l.id) FROM laps l
                              WHERE l.user_id=a.user_id AND l.label_id=a.label_id), 0) AS last_lap,
                    c.input_hash, c.payload`).
			Joins("LEFT JOIN running_calibration_v3_evidence c ON c.user_id=a.user_id AND c.label_id=a.label_id").
			Where("a.user_id=? AND DATE(a.date + INTERVAL 8 HOUR) BETWEEN ? AND ?", uid, start.Format("2006-01-02"), end.Format("2006-01-02")).
			Order("a.date,a.label_id").Scan(&rows).Error
		if err != nil {
			return err
		}
		view := &Store{db: tx, tsBlob: s.tsBlob, tsCache: s.tsCache}
		for i := range rows {
			r := &rows[i]
			if !visit.Running(r.Activity) {
				continue
			}
			sig, err := r.signature(format)
			if err != nil {
				return err
			}
			if sig != nil && bytes.Equal(sig, r.InputHash) && visit.Reuse(r.Payload) {
				continue
			}
			points, err := view.ActivityTimeseries(ctx, uid, r.LabelID)
			if err != nil {
				return err
			}
			laps, err := view.ActivityLaps(ctx, uid, r.LabelID)
			if err != nil {
				return err
			}
			payload, err := visit.Build(r.Activity, points, laps)
			if err != nil {
				return err
			}
			if sig == nil {
				continue
			}
			cache := V3CalibrationEvidence{UserID: uid, LabelID: r.LabelID, ActivityDay: timefmt.ShanghaiDayStr(r.Date), InputHash: sig, Payload: payload}
			if err := tx.Clauses(clause.OnConflict{UpdateAll: true}).Create(&cache).Error; err != nil {
				return err
			}
		}
		if err := tx.Where("user_id=? AND activity_day < ?", uid, start.Format("2006-01-02")).Delete(&V3CalibrationEvidence{}).Error; err != nil {
			return err
		}
		// The legacy reader admits both YYYYMMDD and YYYY-MM-DD health dates.
		// Keep noncanonical rows for the full-path parser (including padded dates).
		return tx.Model(&DailyHealth{}).Select("date,rhr").
			Where("user_id=? AND rhr IS NOT NULL", uid).
			Where("(REPLACE(date, '-', '') BETWEEN ? AND ? OR date NOT REGEXP '^[0-9]{4}-?[0-9]{2}-?[0-9]{2}$')",
				calibration.V3RestingHRStart(end).Format("20060102"), end.Format("20060102")).
			Scan(&health).Error
	}, &sql.TxOptions{Isolation: sql.LevelRepeatableRead})
	if err != nil {
		return nil, fmt.Errorf("v3 evidence window: %w", err)
	}
	return health, nil
}
