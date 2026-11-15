package calibrationsource

import (
	"context"
	"strings"
	"time"

	"github.com/zhaochy1990/stride/internal/compute/calibration"
	"github.com/zhaochy1990/stride/internal/compute/watchmap"
	"github.com/zhaochy1990/stride/internal/storage"
	"github.com/zhaochy1990/stride/internal/utils/timefmt"
)

// CandidateReader adds the existing confirmed-race storage API without changing
// production Load. No SQL, chat mirror or new persistence is introduced here.
type CandidateReader interface {
	Reader
	CandidateMetadataReader
}

// CandidateMetadataReader reuses existing storage semantics; callers that have
// already exported measurements need only these two bounded read operations.
type CandidateMetadataReader interface {
	ActivitiesInWindow(context.Context, string, string, time.Time, time.Time) ([]storage.Activity, error)
	UserRaces(context.Context, string) ([]storage.UserRaceRow, error)
}

// LoadCandidate supplies event-date-retrospective metadata. Current rows cannot
// establish when edited notes/race identity became available, so AvailableAt is
// deliberately nil. Strict replay requires a separately audited availability proof.
func LoadCandidate(ctx context.Context, r CandidateReader, user, provider string, asOf time.Time, lookbackDays int) ([]calibration.Activity, []calibration.HealthRow, []calibration.CandidateMetadata, error) {
	history, health, err := Load(ctx, r, user, provider, asOf, lookbackDays)
	if err != nil {
		return nil, nil, nil, err
	}
	metadata, err := LoadCandidateMetadata(ctx, r, user, provider, asOf, lookbackDays)
	if err != nil {
		return nil, nil, nil, err
	}
	return history, health, metadata, nil
}

// LoadCandidateMetadata reads actual bound notes, device/environment and race
// identity. It emits categorical facts only, with unknown historical availability.
func LoadCandidateMetadata(ctx context.Context, r CandidateMetadataReader, user, provider string, asOf time.Time, lookbackDays int) ([]calibration.CandidateMetadata, error) {
	rows, err := r.ActivitiesInWindow(ctx, user, provider, asOf.AddDate(0, 0, -lookbackDays), asOf)
	if err != nil {
		return nil, err
	}
	races, err := r.UserRaces(ctx, user)
	if err != nil {
		return nil, err
	}
	raceDays := map[string]time.Time{}
	for _, race := range races {
		raceDays[race.LabelID] = timefmt.ShanghaiDay(race.Date)
	}
	metadata := []calibration.CandidateMetadata{}
	for _, a := range rows {
		if !watchmap.IsRunningSport(watchmap.SportFromRow(a.Sport, a.SportType)) {
			continue
		}
		m := calibration.CandidateMetadata{ActivityID: a.LabelID, RootActivityID: a.LabelID, SourceVersion: "storage-candidate-v1", EvidenceRef: "activity_metadata", TemperatureC: a.Temperature, HumidityPercent: a.Humidity, AscentM: a.AscentM, FeelPresent: a.Feel != nil || a.FeelType != nil}
		if a.Device != nil {
			m.Device = *a.Device
		}
		if raceDay, ok := raceDays[a.LabelID]; ok && raceDay.Equal(timefmt.ShanghaiDay(a.Date)) {
			m.RaceIdentity = true
		}
		if a.Sport != nil {
			switch *a.Sport {
			case "trail_run", "run_trail":
				m.Terrain = "trail"
			case "treadmill", "run_indoor":
				m.Terrain = "treadmill"
			}
		}
		// Explicit counter-evidence is conservative. These literal phrases do not
		// verify maximality, and their private source text never leaves this adapter.
		for _, note := range []*string{a.FeelNote, a.SportNote} {
			if note == nil || strings.TrimSpace(*note) == "" {
				continue
			}
			m.NotePresent = true
			normalized := strings.ToLower(*note)
			for _, phrase := range []string{"非全力", "未尽全力", "保留余力", "submaximal", "not all-out", "not maximal"} {
				if strings.Contains(normalized, phrase) {
					m.Submaximal = true
				}
			}
			for _, phrase := range []string{"全力测试", "全力跑", "all-out", "maximal"} {
				if strings.Contains(normalized, phrase) {
					m.AthleteReportedMaximal = true
				}
			}
		}
		if m.Submaximal {
			m.AthleteReportedMaximal = false
		}
		// A course name, subjective rating or race identity alone never asserts a
		// verified protocol or corroborated maximal effort. Plans without actual
		// activity binding are deliberately not used as completed-test evidence.
		metadata = append(metadata, m)
	}
	return metadata, nil
}
