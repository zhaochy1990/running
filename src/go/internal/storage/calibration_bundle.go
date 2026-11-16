package storage

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"github.com/zhaochy1990/stride/internal/compute/calibration"
	"gorm.io/gorm"
	"sort"
	"time"
)

type CalibrationSelection struct {
	Mode             CalibrationMode `json:"mode"`
	PolicyRevision   uint64          `json:"policy_revision"`
	RequestedVersion *int            `json:"requested_version"`
	EffectiveVersion *int            `json:"effective_version"`
	State            string          `json:"state"`
	Reason           string          `json:"reason,omitempty"`
}
type CalibrationBundle struct {
	Selection   CalibrationSelection         `json:"selection"`
	Snapshot    *RunningCalibrationSnapshot  `json:"snapshot"`
	PaceZones   []RunningCalibrationPaceZone `json:"pace_zones"`
	HRZones     []RunningCalibrationHRZone   `json:"hr_zones"`
	Source      calibration.SourceSummary    `json:"source"`
	Fingerprint string                       `json:"fingerprint"`
}

func validCalibrationDay(day string) bool {
	d, err := time.Parse("2006-01-02", day)
	return err == nil && d.Format("2006-01-02") == day
}

// validAlgorithmRevision accepts the historical empty revision and bounded
// opaque revision markers (charset [A-Za-z0-9._-], <= 64 chars). The revision
// participates in the snapshot natural key, so junk values must never enter
// it (#995).
func validAlgorithmRevision(rev string) bool {
	if len(rev) > 64 {
		return false
	}
	for _, r := range rev {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '-', r == '_', r == '.':
		default:
			return false
		}
	}
	return true
}

// ReadEffectiveRunningCalibration selects version before date, and keeps every
// read on one REPEATABLE READ connection. A row with nil centers is still a row.
func (s *Store) ReadEffectiveRunningCalibration(ctx context.Context, user, cutoff string, mode CalibrationMode) (CalibrationBundle, error) {
	out := CalibrationBundle{PaceZones: []RunningCalibrationPaceZone{}, HRZones: []RunningCalibrationHRZone{}}
	uid, err := canonicalUserID(user)
	if err != nil {
		return out, err
	}
	if !validCalibrationDay(cutoff) {
		return out, fmt.Errorf("invalid calibration cutoff day")
	}
	if mode != CalibrationActive && mode != CalibrationCandidate {
		return out, fmt.Errorf("invalid calibration selection mode")
	}
	err = s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		policy, err := readCalibrationPolicy(tx)
		if err != nil {
			return err
		}
		preferred := &policy.ActiveVersion
		if mode == CalibrationCandidate {
			preferred = policy.CandidateVersion
		}
		out.Selection = CalibrationSelection{Mode: mode, PolicyRevision: policy.Revision, RequestedVersion: preferred, State: "unavailable", Reason: "no_historical_snapshot"}
		versions := []int{}
		if preferred != nil {
			versions = append(versions, *preferred)
		}
		if preferred == nil || *preferred != policy.FallbackVersion {
			versions = append(versions, policy.FallbackVersion)
		}
		for _, v := range versions {
			var rows []RunningCalibrationSnapshot
			if err := tx.Where("user_id = ? AND algorithm_version = ? AND as_of_date <= ?", uid, v, cutoff).Order("as_of_date DESC, id DESC").Limit(1).Find(&rows).Error; err != nil {
				return err
			}
			if len(rows) == 0 {
				continue
			}
			snap := rows[0]
			out.Snapshot = &snap
			effective := v
			out.Selection.EffectiveVersion = &effective
			out.Selection.State = "selected"
			out.Selection.Reason = ""
			if preferred == nil || v != *preferred {
				out.Selection.State = "fallback"
				out.Selection.Reason = "preferred_snapshot_missing"
				if preferred == nil {
					out.Selection.Reason = "candidate_not_configured"
				}
			}
			if err := tx.Where("user_id = ? AND snapshot_id = ?", uid, snap.ID).Order("name").Find(&out.PaceZones).Error; err != nil {
				return err
			}
			if err := tx.Where("user_id = ? AND snapshot_id = ?", uid, snap.ID).Order("name").Find(&out.HRZones).Error; err != nil {
				return err
			}
			out.Source = calibration.ParseSource(snap.SourceJSON)
			out.Fingerprint = out.Source.Fingerprint
			return nil
		}
		if preferred == nil {
			out.Selection.Reason = "candidate_not_configured"
		}
		out.Source = calibration.SourceSummary{State: "snapshot_unavailable"}
		return nil
	}, &sql.TxOptions{Isolation: sql.LevelRepeatableRead, ReadOnly: true})
	return out, err
}

// PublishRunningCalibration preserves the natural key (user_id, as_of_date,
// algorithm_version, algorithm_revision) and publishes snapshot plus both zone
// tables atomically. Copies protect caller-owned inputs. Same-key republish is
// an idempotent overwrite (same-day recompute); a different algorithm_revision
// writes a separate row, so historical v4 rows (revision ”) are never
// overwritten by the evolved v4 (#995, ADR 0045).
func (s *Store) PublishRunningCalibration(ctx context.Context, snapshot *RunningCalibrationSnapshot, pace []RunningCalibrationPaceZone, hr []RunningCalibrationHRZone) (uint64, error) {
	if snapshot == nil {
		return 0, fmt.Errorf("nil calibration snapshot")
	}
	snap := *snapshot
	uid, err := canonicalUserID(snap.UserID)
	if err != nil {
		return 0, err
	}
	snap.UserID = uid
	snap.ID = 0
	if !validCalibrationDay(snap.AsOfDate) || !validCalibrationVersion(snap.AlgorithmVersion) || !validAlgorithmRevision(snap.AlgorithmRevision) {
		return 0, fmt.Errorf("invalid calibration identity")
	}
	p := append([]RunningCalibrationPaceZone(nil), pace...)
	h := append([]RunningCalibrationHRZone(nil), hr...)
	for i := range p {
		p[i].ID = 0
	}
	for i := range h {
		h[i].ID = 0
	}
	summary := calibration.ParseSource(snap.SourceJSON)
	if summary.State == "available" {
		summary.Fingerprint = ""
		raw, err := json.Marshal(summary)
		if err != nil {
			return 0, err
		}
		text := string(raw)
		snap.SourceJSON = &text
		fp, err := calibrationFingerprint(snap, p, h)
		if err != nil {
			return 0, err
		}
		summary.Fingerprint = fp
		raw, err = json.Marshal(summary)
		if err != nil {
			return 0, err
		}
		text = string(raw)
		snap.SourceJSON = &text
	}
	var id uint64
	err = s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		scoped := *s
		scoped.db = tx
		var err error
		id, err = scoped.UpsertRunningCalibrationSnapshot(ctx, &snap)
		if err != nil {
			return err
		}
		return scoped.ReplaceCalibrationZones(ctx, snap.UserID, id, p, h)
	})
	return id, err
}
func calibrationFingerprint(snap RunningCalibrationSnapshot, p []RunningCalibrationPaceZone, h []RunningCalibrationHRZone) (string, error) {
	snap.ID = 0
	snap.ComputedAt = time.Time{}
	p = append([]RunningCalibrationPaceZone(nil), p...)
	h = append([]RunningCalibrationHRZone(nil), h...)
	for i := range p {
		p[i].ID = 0
		p[i].SnapshotID = 0
		p[i].UserID = ""
	}
	for i := range h {
		h[i].ID = 0
		h[i].SnapshotID = 0
		h[i].UserID = ""
	}
	sort.Slice(p, func(i, j int) bool { return p[i].Name < p[j].Name })
	sort.Slice(h, func(i, j int) bool { return h[i].Name < h[j].Name })
	raw, err := json.Marshal(struct {
		Snapshot RunningCalibrationSnapshot
		Pace     []RunningCalibrationPaceZone
		HR       []RunningCalibrationHRZone
	}{snap, p, h})
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:]), nil
}
