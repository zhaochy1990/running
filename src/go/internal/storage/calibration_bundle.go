package storage

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"sort"
	"time"

	"github.com/zhaochy1990/stride/internal/compute/calibration"
	"gorm.io/gorm"
)

type CalibrationSelection struct {
	Mode             CalibrationMode `json:"mode"`
	PolicyRevision   uint64          `json:"policy_revision"`
	RequestedVersion *int            `json:"requested_version"`
	EffectiveVersion *int            `json:"effective_version"`
	State            string          `json:"state"`
	Reason           string          `json:"reason,omitempty"`
	// Override (#999) discloses the user's explicit per-user selection when one
	// is active for this read — including when the read fell back because the
	// pinned identity has no snapshot at/below the cutoff.
	Override *CalibrationOverrideSelection `json:"override,omitempty"`
}
type CalibrationBundle struct {
	Selection   CalibrationSelection         `json:"selection"`
	Snapshot    *RunningCalibrationSnapshot  `json:"snapshot"`
	PaceZones   []RunningCalibrationPaceZone `json:"pace_zones"`
	HRZones     []RunningCalibrationHRZone   `json:"hr_zones"`
	Source      calibration.SourceSummary    `json:"source"`
	Fingerprint string                       `json:"fingerprint"`
}

// CalibrationThresholdPoint contains the persisted threshold centers for one snapshot date.
type CalibrationThresholdPoint struct {
	AsOfDate          string
	ThresholdSpeedMps *float64
	ThresholdHR       *float64
}

// CalibrationThresholdHistory pairs saved points with the last valid speed before the window.
type CalibrationThresholdHistory struct {
	Points        []CalibrationThresholdPoint
	PriorSpeedMps *float64
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
//
// Since #999 an explicitly authorized per-user override wins for active reads:
// the override pins one (algorithm_version, algorithm_revision) identity that
// is read with the revision in the WHERE clause, ahead of the global policy's
// preferred and fallback versions (which stay unpinned — latest-row tiebreak).
// When the pinned identity has no snapshot at/below the cutoff the chain falls
// back to the global selection with reason override_snapshot_missing, so a
// today-published new revision never backfills history. Candidate reads never
// consult the override: they remain the explicit global comparison channel.
func (s *Store) ReadEffectiveRunningCalibration(ctx context.Context, user, cutoff string, mode CalibrationMode) (CalibrationBundle, error) {
	bundle, _, err := s.readEffectiveRunningCalibration(ctx, user, cutoff, mode, "")
	return bundle, err
}

// ReadEffectiveRunningCalibrationWithHistory reads the active bundle and the
// saved thresholds for its exact algorithm identity, oldest first. The
// inclusive history range and prior speed share the bundle's read-only transaction.
func (s *Store) ReadEffectiveRunningCalibrationWithHistory(ctx context.Context, user, from, cutoff string) (CalibrationBundle, CalibrationThresholdHistory, error) {
	if !validCalibrationDay(from) || from > cutoff {
		return CalibrationBundle{}, CalibrationThresholdHistory{}, fmt.Errorf("invalid calibration history start day")
	}
	return s.readEffectiveRunningCalibration(ctx, user, cutoff, CalibrationActive, from)
}

func (s *Store) readEffectiveRunningCalibration(ctx context.Context, user, cutoff string, mode CalibrationMode, historyStart string) (CalibrationBundle, CalibrationThresholdHistory, error) {
	out := CalibrationBundle{PaceZones: []RunningCalibrationPaceZone{}, HRZones: []RunningCalibrationHRZone{}}
	var history CalibrationThresholdHistory
	uid, err := canonicalUserID(user)
	if err != nil {
		return out, history, err
	}
	if !validCalibrationDay(cutoff) {
		return out, history, fmt.Errorf("invalid calibration cutoff day")
	}
	if mode != CalibrationActive && mode != CalibrationCandidate {
		return out, history, fmt.Errorf("invalid calibration selection mode")
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
		var override *RunningCalibrationUserOverride
		if mode == CalibrationActive {
			if override, err = readActiveCalibrationOverride(tx, uid); err != nil {
				return err
			}
		}
		requested := preferred
		if override != nil {
			v := override.AlgorithmVersion
			requested = &v
		}
		out.Selection = CalibrationSelection{Mode: mode, PolicyRevision: policy.Revision, RequestedVersion: requested, State: "unavailable", Reason: "no_historical_snapshot"}
		if override != nil {
			out.Selection.Override = &CalibrationOverrideSelection{Revision: override.Revision, AlgorithmVersion: override.AlgorithmVersion, AlgorithmRevision: override.AlgorithmRevision}
		}
		// Selection chain: the override's pinned identity first, then the global
		// preferred version, then the global fallback. The first target with a
		// snapshot row at/below the cutoff wins.
		type selectionTarget struct {
			version      int
			revision     string
			pinned       bool
			fromOverride bool
		}
		chain := []selectionTarget{}
		if override != nil {
			chain = append(chain, selectionTarget{version: override.AlgorithmVersion, revision: override.AlgorithmRevision, pinned: true, fromOverride: true})
		}
		if preferred != nil {
			chain = append(chain, selectionTarget{version: *preferred})
		}
		if preferred == nil || *preferred != policy.FallbackVersion {
			chain = append(chain, selectionTarget{version: policy.FallbackVersion})
		}
		for i, target := range chain {
			q := tx.Where("user_id = ? AND algorithm_version = ? AND as_of_date <= ?", uid, target.version, cutoff)
			if target.pinned {
				q = q.Where("algorithm_revision = ?", target.revision)
			}
			var rows []RunningCalibrationSnapshot
			if err := q.Order("as_of_date DESC, id DESC").Limit(1).Find(&rows).Error; err != nil {
				return err
			}
			if len(rows) == 0 {
				continue
			}
			snap := rows[0]
			out.Snapshot = &snap
			effective := snap.AlgorithmVersion
			out.Selection.EffectiveVersion = &effective
			out.Selection.State = "selected"
			out.Selection.Reason = ""
			if i > 0 {
				out.Selection.State = "fallback"
				out.Selection.Reason = "preferred_snapshot_missing"
				if chain[0].fromOverride {
					out.Selection.Reason = "override_snapshot_missing"
				}
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
			if historyStart != "" {
				q := tx.Model(&RunningCalibrationSnapshot{}).
					Where("user_id = ? AND algorithm_version = ? AND algorithm_revision = ?", uid, snap.AlgorithmVersion, snap.AlgorithmRevision).
					Session(&gorm.Session{})
				if err := q.Select("as_of_date", "threshold_speed_mps", "threshold_hr").
					Where("as_of_date BETWEEN ? AND ?", historyStart, cutoff).
					Order("as_of_date ASC").Find(&history.Points).Error; err != nil {
					return err
				}
				var prior []float64
				if err := q.Where("as_of_date < ? AND threshold_speed_mps > 0", historyStart).
					Order("as_of_date DESC").Limit(1).Pluck("threshold_speed_mps", &prior).Error; err != nil {
					return err
				}
				if len(prior) > 0 {
					history.PriorSpeedMps = &prior[0]
				}
			}
			return nil
		}
		if preferred == nil {
			out.Selection.Reason = "candidate_not_configured"
		} else if override != nil {
			out.Selection.Reason = "override_snapshot_missing"
		}
		out.Source = calibration.SourceSummary{State: "snapshot_unavailable"}
		return nil
	}, &sql.TxOptions{Isolation: sql.LevelRepeatableRead, ReadOnly: true})
	return out, history, err
}

// PublishRunningCalibration preserves the natural key (user_id, as_of_date,
// algorithm_version, algorithm_revision) and publishes snapshot plus both zone
// tables atomically. Copies protect caller-owned inputs. Same-key republish is
// an idempotent overwrite (same-day recompute); a different algorithm_revision
// writes a separate row, so historical v4 rows (revision ”) are never
// overwritten by the evolved v4 (#995, ADR 0045).
func (s *Store) PublishRunningCalibration(ctx context.Context, snapshot *RunningCalibrationSnapshot, pace []RunningCalibrationPaceZone, hr []RunningCalibrationHRZone) (uint64, error) {
	snap, p, h, _, err := prepareCalibrationPublication(snapshot, pace, hr)
	if err != nil {
		return 0, err
	}
	var id uint64
	err = s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		scoped := *s
		scoped.db = tx
		var err error
		id, err = scoped.UpsertRunningCalibrationSnapshot(ctx, snap)
		if err != nil {
			return err
		}
		return scoped.ReplaceCalibrationZones(ctx, snap.UserID, id, p, h)
	})
	return id, err
}

// PublishUserCalibrationOverride is the #999 single-user publish boundary: the
// pinned-identity snapshot, both zone tables and the user's active override
// commit in one transaction, so an override never becomes readable without its
// snapshot and a mid-transaction failure leaves both untouched. The override
// upsert is idempotent on identity — an already-active identical override is
// kept as-is (no revision bump, no audit rewrite), which makes a retried
// publish job safe.
func (s *Store) PublishUserCalibrationOverride(ctx context.Context, snapshot *RunningCalibrationSnapshot, pace []RunningCalibrationPaceZone, hr []RunningCalibrationHRZone, override RunningCalibrationUserOverride) (uint64, error) {
	if snapshot == nil {
		return 0, fmt.Errorf("nil calibration snapshot")
	}
	if override.AlgorithmVersion != snapshot.AlgorithmVersion || override.AlgorithmRevision != snapshot.AlgorithmRevision {
		return 0, fmt.Errorf("override identity must match the published snapshot identity")
	}
	snap, p, h, uid, err := prepareCalibrationPublication(snapshot, pace, hr)
	if err != nil {
		return 0, err
	}
	override.UserID = uid
	if err := validateCalibrationOverride(override); err != nil {
		return 0, err
	}
	var id uint64
	err = s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		scoped := *s
		scoped.db = tx
		var err error
		id, err = scoped.UpsertRunningCalibrationSnapshot(ctx, snap)
		if err != nil {
			return err
		}
		if err := scoped.ReplaceCalibrationZones(ctx, snap.UserID, id, p, h); err != nil {
			return err
		}
		return upsertOverrideForPublish(tx, override)
	})
	return id, err
}

// prepareCalibrationPublication copies and validates the caller-owned inputs
// and stamps the source fingerprint, shared by both publish paths.
func prepareCalibrationPublication(snapshot *RunningCalibrationSnapshot, pace []RunningCalibrationPaceZone, hr []RunningCalibrationHRZone) (*RunningCalibrationSnapshot, []RunningCalibrationPaceZone, []RunningCalibrationHRZone, string, error) {
	if snapshot == nil {
		return nil, nil, nil, "", fmt.Errorf("nil calibration snapshot")
	}
	snap := *snapshot
	uid, err := canonicalUserID(snap.UserID)
	if err != nil {
		return nil, nil, nil, "", err
	}
	snap.UserID = uid
	snap.ID = 0
	if !validCalibrationDay(snap.AsOfDate) || !validCalibrationVersion(snap.AlgorithmVersion) || !validAlgorithmRevision(snap.AlgorithmRevision) {
		return nil, nil, nil, "", fmt.Errorf("invalid calibration identity")
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
			return nil, nil, nil, "", err
		}
		text := string(raw)
		snap.SourceJSON = &text
		fp, err := calibrationFingerprint(snap, p, h)
		if err != nil {
			return nil, nil, nil, "", err
		}
		summary.Fingerprint = fp
		raw, err = json.Marshal(summary)
		if err != nil {
			return nil, nil, nil, "", err
		}
		text = string(raw)
		snap.SourceJSON = &text
	}
	return &snap, p, h, uid, nil
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
