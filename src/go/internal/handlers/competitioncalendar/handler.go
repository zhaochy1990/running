// Package competitioncalendar provides the worker job handlers for the
// competition_calendar_sync pipeline: "fetch_wa_api_key" discovers the current
// World Athletics AppSync endpoint + API key from the site bundle, and
// "competition_calendar_sync" fetches one or more seasons of a competition-group
// calendar (the label road races by default) and mirrors them into the
// competition_calendar table. Both are internal-only, system-scoped steps —
// there is no subject user.
//
// The calendar handler reads endpoint/api_key from the job input (threaded by
// the pipeline from the key step's result) and overrides its configured client
// credentials with them when both are present. Seasons come from the job input
// ({"seasons":["2026","2027"]}) when supplied, else the handler's configured
// defaults, else the current Shanghai year.
package competitioncalendar

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/zhaochy1990/stride/internal/job"
	"github.com/zhaochy1990/stride/internal/storage"
	"github.com/zhaochy1990/stride/internal/utils/timefmt"
	"github.com/zhaochy1990/stride/internal/worldathletics"
)

// JobType is the registered job_type for the competition-calendar sync handler.
const JobType = "competition_calendar_sync"

// Source labels the rows this handler writes: the World Athletics competition
// group it mirrors. Kept as a distinct value so the same table can later hold
// other calendar sources.
const Source = "world-athletics-label-road-races"

// CalendarStore is the slice of *storage.Store the handler needs, so the
// handler stays unit-testable with a fake. cmd/worker injects the real store.
type CalendarStore interface {
	ReplaceCompetitionCalendarSeason(ctx context.Context, source, season string, events []storage.CompetitionCalendarEvent) (storage.ReplaceCompetitionCalendarResult, error)
}

// Config is the handler's static dependencies and defaults, wired in cmd/worker.
type Config struct {
	Client                *worldathletics.Client
	Store                 CalendarStore
	CompetitionGroupID    int
	CompetitionSubgroupID int
	// DefaultSeasons is used when the job input omits "seasons". Empty means the
	// current Shanghai year.
	DefaultSeasons []string
}

// New returns the competition_calendar_sync job.Handler.
func New(cfg Config) job.Handler {
	return func(ctx context.Context, j *job.Job, hb job.Heartbeat) (string, error) {
		in, err := resolveInput(j.InputJSON)
		if err != nil {
			// A malformed payload can't be fixed by retrying.
			return "", job.NewPermanentError("bad_payload", err)
		}

		seasons := in.Seasons
		if len(seasons) == 0 {
			seasons = cfg.DefaultSeasons
		}
		if len(seasons) == 0 {
			seasons = []string{currentSeason()}
		}

		// The pipeline threads the key step's discovered credentials into this
		// job's input; prefer them over the configured default when both present.
		client := cfg.Client
		if in.Endpoint != "" && in.APIKey != "" {
			client = cfg.Client.WithCredentials(in.Endpoint, in.APIKey)
		}

		out := struct {
			Seasons map[string]seasonSummary `json:"seasons"`
		}{Seasons: make(map[string]seasonSummary)}

		for _, season := range seasons {
			stage := "fetch:" + season
			_ = hb(stage, 10)
			events, err := client.MinisiteCalendar(ctx, season, cfg.CompetitionGroupID, cfg.CompetitionSubgroupID)
			if err != nil {
				return "", err
			}
			_ = hb(stage, 60)

			rows := make([]storage.CompetitionCalendarEvent, 0, len(events))
			for _, e := range events {
				rows = append(rows, toRow(e))
			}
			res, err := cfg.Store.ReplaceCompetitionCalendarSeason(ctx, Source, season, rows)
			if err != nil {
				if storage.IsDeterministicWriteError(err) {
					return "", job.NewPermanentError("storage_constraint", err)
				}
				return "", err
			}
			_ = hb(stage, 100)
			out.Seasons[season] = seasonSummary{Fetched: len(events), Upserted: res.Upserted, Deleted: res.Deleted}
		}

		result, _ := json.Marshal(out)
		return string(result), nil
	}
}

// seasonSummary is the per-season result reported in the job's result_json.
type seasonSummary struct {
	Fetched  int `json:"fetched"`
	Upserted int `json:"upserted"`
	Deleted  int `json:"deleted"`
}

// jobInput is the job's input: the run-level {"seasons":[...]} merged (by the
// pipeline) with the key step's discovered {"endpoint":...,"api_key":...}.
type jobInput struct {
	Seasons  []string `json:"seasons"`
	Endpoint string   `json:"endpoint"`
	APIKey   string   `json:"api_key"`
}

// resolveInput parses the job input. Empty input yields a zero jobInput (no
// overrides); a malformed one is an error the caller turns into a permanent job
// failure (retrying can't fix it).
func resolveInput(inputJSON string) (jobInput, error) {
	if strings.TrimSpace(inputJSON) == "" {
		return jobInput{}, nil
	}
	var in jobInput
	if err := json.Unmarshal([]byte(inputJSON), &in); err != nil {
		return jobInput{}, err
	}
	return in, nil
}

// currentSeason is the World Athletics season (the calendar year) as of today's
// Shanghai day, matching the site's season dropdown default.
func currentSeason() string {
	return fmt.Sprintf("%d", timefmt.ShanghaiToday().Year())
}

func toRow(e worldathletics.Event) storage.CompetitionCalendarEvent {
	return storage.CompetitionCalendarEvent{
		EventID:                   e.ID,
		IaafID:                    e.IaafID,
		Name:                      e.Name,
		Venue:                     strPtr(strings.TrimSpace(e.Venue)),
		Country:                   strPtr(strings.TrimSpace(e.Country)),
		StartDate:                 e.StartDate,
		EndDate:                   e.EndDate,
		DateRange:                 e.DateRange,
		Disciplines:               strPtr(e.Disciplines),
		RankingCategory:           strPtr(e.RankingCategory),
		CompetitionSubgroup:       strPtr(e.CompetitionSubgroup),
		HasResults:                e.HasResults,
		HasStartlist:              e.HasStartlist,
		HasAPIResults:             e.HasAPIResults,
		HasCompetitionInformation: e.HasCompetitionInformation,
	}
}

func strPtr(s string) *string { return &s }
