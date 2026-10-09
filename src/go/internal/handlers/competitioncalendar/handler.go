// Package competitioncalendar provides the worker job handlers for the
// race_calendar_sync pipeline: "fetch_wa_api_key" discovers the current
// World Athletics AppSync endpoint + API key from the site bundle, and
// "race_calendar_sync" fetches one or more years of a competition-group
// calendar (the label road races by default) and mirrors them into the
// race_calendar table. Both are internal-only, system-scoped steps — there is
// no subject user.
//
// The calendar handler reads endpoint/api_key from the job input (threaded by
// the pipeline from the key step's result) and overrides its configured client
// credentials with them when both are present. Years come from the job input
// ({"years":["2026","2027"]}) when supplied, else the handler's configured
// defaults, else the current Shanghai year. It also parses the upstream venue
// string into a three-level address (country/province/city) and maps Chinese
// cities to their Chinese names via the curated tables in geocode.go.
//
// Since devops#443 the mirror also dedups: a World Athletics listing for a
// Chinese race whose (race_date, city) matches an existing Chinese row
// (中国田协 or manual) is not written — its tier is applied to that row instead
// (see dedup.go), so one race is one row.
package competitioncalendar

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"go.uber.org/zap"

	"github.com/zhaochy1990/stride/internal/job"
	"github.com/zhaochy1990/stride/internal/logging"
	"github.com/zhaochy1990/stride/internal/racetypes"
	"github.com/zhaochy1990/stride/internal/storage"
	"github.com/zhaochy1990/stride/internal/utils/timefmt"
	"github.com/zhaochy1990/stride/internal/worldathletics"
)

// JobType is the registered job_type for the race-calendar sync handler.
const JobType = "race_calendar_sync"

// Source labels the rows this handler writes — a fixed Chinese value per source
// (国际田联 for the World Athletics label road races; 中国田协 for the China
// Athletics Association catalogue). Aliased to the storage constant so the
// storage layer and the handlers cannot drift apart.
const Source = storage.RaceSourceWorldAth

// CalendarStore is the slice of *storage.Store the handler needs, so the
// handler stays unit-testable with a fake. cmd/worker injects the real store.
type CalendarStore interface {
	ReplaceRaceCalendarYear(ctx context.Context, source, year string, races []storage.RaceCalendarEvent) (storage.ReplaceRaceCalendarResult, error)
	// LoadRaceCalendarDedupScope + ApplyRaceCalendarWALabels serve the dedup
	// (devops#443): the year's Chinese rows to match against, and the tier
	// writes for the rows a listing merges into.
	LoadRaceCalendarDedupScope(ctx context.Context, year string) ([]storage.RaceCalendarEvent, error)
	ApplyRaceCalendarWALabels(ctx context.Context, labels []storage.RaceCalendarWALabel) (int, error)
}

// Config is the handler's static dependencies and defaults, wired in cmd/worker.
type Config struct {
	Client                *worldathletics.Client
	Store                 CalendarStore
	CompetitionGroupID    int
	CompetitionSubgroupID int
	// DefaultYears is used when the job input omits "years". Empty means the
	// current Shanghai year.
	DefaultYears []string
	// Logger is the structured logger for this handler's diagnostics. nil falls
	// back to the process logger.
	Logger *zap.Logger
}

// New returns the race_calendar_sync job.Handler.
func New(cfg Config) job.Handler {
	log := cfg.Logger
	if log == nil {
		log = logging.Default()
	}
	return func(ctx context.Context, j *job.Job, hb job.Heartbeat) (string, error) {
		in, err := resolveInput(j.InputJSON)
		if err != nil {
			// A malformed payload can't be fixed by retrying.
			log.Error("race_calendar_sync: malformed job input",
				zap.String("job_id", j.ID),
				zap.String("error_code", "bad_payload"),
				zap.Error(err))
			return "", job.NewPermanentError("bad_payload", err)
		}

		years := in.Years
		if len(years) == 0 {
			years = cfg.DefaultYears
		}
		if len(years) == 0 {
			years = []string{currentYear()}
		}

		// The pipeline threads the key step's discovered credentials into this
		// job's input; prefer them over the configured default when both present.
		client := cfg.Client
		if in.Endpoint != "" && in.APIKey != "" {
			client = cfg.Client.WithCredentials(in.Endpoint, in.APIKey)
			log.Info("race_calendar_sync: using discovered credentials from the key step",
				zap.String("job_id", j.ID),
				zap.String("endpoint", in.Endpoint),
				zap.String("api_key", worldathletics.MaskKey(in.APIKey)))
		} else {
			log.Info("race_calendar_sync: using configured credentials",
				zap.String("job_id", j.ID),
				zap.String("endpoint", cfg.Client.Endpoint()))
		}

		out := struct {
			Years map[string]yearSummary `json:"years"`
		}{Years: make(map[string]yearSummary)}

		for _, year := range years {
			stage := "fetch:" + year
			_ = hb(stage, 10)
			events, err := client.MinisiteCalendar(ctx, year, cfg.CompetitionGroupID, cfg.CompetitionSubgroupID)
			if err != nil {
				log.Error("race_calendar_sync: year fetch failed",
					zap.String("job_id", j.ID),
					zap.String("year", year),
					zap.String("endpoint", client.Endpoint()),
					zap.Int("competition_group_id", cfg.CompetitionGroupID),
					zap.Error(err))
				return "", err
			}
			_ = hb(stage, 60)

			rows := make([]storage.RaceCalendarEvent, 0, len(events))
			for _, e := range events {
				rows = append(rows, toRow(e))
			}

			// Dedup (devops#443): a Chinese race's World Athletics listing must
			// not become a second row beside the Chinese one. Matched listings
			// are dropped from the write — which also stale-deletes the
			// duplicate rows earlier runs left behind — and their tiers land on
			// the Chinese rows. An empty upstream skips the dedup entirely: like
			// the mirror write, a reconcile over nothing must not clear tiers.
			var keep []storage.RaceCalendarEvent
			var labels []storage.RaceCalendarWALabel
			var dedup mirrorDedupSummary
			if len(rows) > 0 {
				candidates, err := cfg.Store.LoadRaceCalendarDedupScope(ctx, year)
				if err != nil {
					log.Error("race_calendar_sync: dedup scope load failed",
						zap.String("job_id", j.ID),
						zap.String("year", year),
						zap.Error(err))
					return "", err
				}
				keep, labels, dedup = planMirrorDedup(rows, candidates)
				if dedup.Ambiguous > 0 || dedup.TypeRefused > 0 {
					log.Warn("race_calendar_sync: listings kept on refused matches",
						zap.String("job_id", j.ID),
						zap.String("year", year),
						zap.Int("ambiguous", dedup.Ambiguous),
						zap.Int("type_refused", dedup.TypeRefused))
				}
			} else {
				keep = rows
			}

			res, err := cfg.Store.ReplaceRaceCalendarYear(ctx, Source, year, keep)
			if err != nil {
				if storage.IsDeterministicWriteError(err) {
					log.Error("race_calendar_sync: year write failed (deterministic)",
						zap.String("job_id", j.ID),
						zap.String("year", year),
						zap.String("error_code", "storage_constraint"),
						zap.Error(err))
					return "", job.NewPermanentError("storage_constraint", err)
				}
				log.Error("race_calendar_sync: year write failed",
					zap.String("job_id", j.ID),
					zap.String("year", year),
					zap.Error(err))
				return "", err
			}
			_ = hb(stage, 90)

			// The tier writes ride on the same guards as the wa_label job's
			// (sync-owned rows only, never over an administrator's override), so
			// applied can legitimately be smaller than sent.
			applied := 0
			if len(labels) > 0 {
				applied, err = cfg.Store.ApplyRaceCalendarWALabels(ctx, labels)
				if err != nil {
					if storage.IsDeterministicWriteError(err) {
						log.Error("race_calendar_sync: wa_label write failed (deterministic)",
							zap.String("job_id", j.ID),
							zap.String("year", year),
							zap.String("error_code", "storage_constraint"),
							zap.Error(err))
						return "", job.NewPermanentError("storage_constraint", err)
					}
					log.Error("race_calendar_sync: wa_label write failed",
						zap.String("job_id", j.ID),
						zap.String("year", year),
						zap.Error(err))
					return "", err
				}
			}
			_ = hb(stage, 100)
			skipped := dedup.Ambiguous + dedup.TypeRefused
			out.Years[year] = yearSummary{
				Fetched: len(events), Upserted: res.Upserted, Deleted: res.Deleted,
				Deduped: dedup.Deduped, Stamped: dedup.Stamped, Cleared: dedup.Cleared,
				Skipped: skipped, Applied: applied,
			}
			log.Info("race_calendar_sync: year synced",
				zap.String("job_id", j.ID),
				zap.String("year", year),
				zap.Int("fetched", len(events)),
				zap.Int("upserted", res.Upserted),
				zap.Int("deleted", res.Deleted),
				zap.Int("deduped", dedup.Deduped),
				zap.Int("stamped", dedup.Stamped),
				zap.Int("cleared", dedup.Cleared),
				zap.Int("skipped", skipped),
				zap.Int("labels_applied", applied))
		}

		result, _ := json.Marshal(out)
		return string(result), nil
	}
}

// yearSummary is the per-year result reported in the job's result_json. The
// dedup fields (devops#443) are the mirror's match decisions: Deduped listings
// not written because a Chinese row covers them, Stamped/Cleared the wa_label
// values sent for those rows (set/change/remove, before the store's origin and
// override guards), Applied what the store actually wrote, Skipped the listings
// kept on a refused match (ambiguous or type-contradicting) — each of those is
// worth an operator's glance when it stops being zero.
type yearSummary struct {
	Fetched  int `json:"fetched"`
	Upserted int `json:"upserted"`
	Deleted  int `json:"deleted"`
	Deduped  int `json:"deduped"`
	Stamped  int `json:"stamped"`
	Cleared  int `json:"cleared"`
	Skipped  int `json:"skipped"`
	Applied  int `json:"applied"`
}

// jobInput is the job's input: the run-level {"years":[...]} merged (by the
// pipeline) with the key step's discovered {"endpoint":...,"api_key":...}.
type jobInput struct {
	Years    []string `json:"years"`
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

// currentYear is the World Athletics season (the calendar year) as of today's
// Shanghai day, matching the site's season dropdown default.
func currentYear() string {
	return fmt.Sprintf("%d", timefmt.ShanghaiToday().Year())
}

// toRow maps an upstream calendar event into a race_calendar row, parsing the
// venue into the three-level address (province/city), deriving the race types
// from the ranking category (GW/GL only — everything else is Unknown), and
// leaving name_cn NULL for later curation.
func toRow(e worldathletics.Event) storage.RaceCalendarEvent {
	province, city := parseLocation(e.Venue, e.Country)
	types, _ := json.Marshal(racetypes.FromWACategory(e.RankingCategory))
	return storage.RaceCalendarEvent{
		Name:      e.Name,
		RaceDate:  e.StartDate,
		Country:   strings.TrimSpace(e.Country),
		Province:  strPtrOrNil(province),
		City:      strPtrOrNil(city),
		Label:     strPtrOrNil(e.CompetitionSubgroup),
		RaceTypes: strPtrOrNil(string(types)),
	}
}

// strPtrOrNil maps an empty string to a nil pointer (NULL in MySQL).
func strPtrOrNil(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}
