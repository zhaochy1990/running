// Package chinaathcalendar provides the worker job handler for the
// chinaath_race_calendar_sync pipeline: it fetches the full 中国田协
// competition catalogue (one paginated call chain, no auth) and mirrors the
// requested years into the race_calendar table (source 中国田协). It is an
// internal-only, system-scoped step — there is no subject user.
//
// The upstream API has no year filter, so the handler pulls the whole
// catalogue (~30 pages at pageSize 100) once and filters years in memory,
// then reuses storage.ReplaceRaceCalendarYear per year — the same
// mirror-by-year contract as the World Athletics handler. Unlike that
// pipeline there is no key-discovery step (the upstream needs no
// credentials), so this is a single-job pipeline.
//
// Rows keep the upstream Chinese race name in both name and name_cn
// (name_cn is excluded from the upsert refresh, so later curations survive
// re-syncs). The raceAddress string ("省/市/区") is split into
// country/province/city, and the raceItem array is mapped to the shared
// internal/racetypes vocabulary.
package chinaathcalendar

import (
	"context"
	"encoding/json"
	"strconv"
	"strings"

	"go.uber.org/zap"

	"github.com/zhaochy1990/stride/internal/chinaath"
	"github.com/zhaochy1990/stride/internal/job"
	"github.com/zhaochy1990/stride/internal/logging"
	"github.com/zhaochy1990/stride/internal/racetypes"
	"github.com/zhaochy1990/stride/internal/storage"
	"github.com/zhaochy1990/stride/internal/utils/timefmt"
)

// JobType is the registered job_type for the 田协 race-calendar sync handler.
const JobType = "chinaath_race_calendar_sync"

// Source labels the rows this handler writes — the fixed Chinese source value
// the WA handler's Source comment reserved for this catalogue.
const Source = "中国田协"

// CalendarStore is the slice of *storage.Store the handler needs, so the
// handler stays unit-testable with a fake. cmd/worker injects the real store.
type CalendarStore interface {
	ReplaceRaceCalendarYear(ctx context.Context, source, year string, races []storage.RaceCalendarEvent) (storage.ReplaceRaceCalendarResult, error)
}

// Config is the handler's static dependencies and defaults, wired in cmd/worker.
type Config struct {
	Client *chinaath.Client
	Store  CalendarStore
	// DefaultYears is used when the job input omits "years". Empty means the
	// current and next Shanghai years (the upstream catalogue also carries
	// years of history, which a plain mirror must not touch).
	DefaultYears []string
	// Logger is the structured logger for this handler's diagnostics. nil falls
	// back to the process logger.
	Logger *zap.Logger
}

// New returns the chinaath_race_calendar_sync job.Handler.
func New(cfg Config) job.Handler {
	log := cfg.Logger
	if log == nil {
		log = logging.Default()
	}
	return func(ctx context.Context, j *job.Job, hb job.Heartbeat) (string, error) {
		in, err := resolveInput(j.InputJSON)
		if err != nil {
			// A malformed payload can't be fixed by retrying.
			log.Error("chinaath_race_calendar_sync: malformed job input",
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
			years = defaultYears()
		}
		wanted := make(map[string]bool, len(years))
		for _, y := range years {
			wanted[y] = true
		}

		_ = hb("fetch", 10)
		races, err := cfg.Client.Races(ctx)
		if err != nil {
			log.Error("chinaath_race_calendar_sync: catalogue fetch failed",
				zap.String("job_id", j.ID),
				zap.String("endpoint", cfg.Client.Endpoint()),
				zap.Error(err))
			return "", err
		}
		_ = hb("fetch", 40)

		// Group the catalogue by year so each wanted year gets its own
		// mirror-by-year write; years outside the request are ignored (the
		// catalogue also carries years of history).
		byYear := map[string][]storage.RaceCalendarEvent{}
		for _, r := range races {
			if len(r.RaceTime) < 4 {
				continue
			}
			year := r.RaceTime[:4]
			if !wanted[year] {
				continue
			}
			byYear[year] = append(byYear[year], toRow(r))
		}

		out := struct {
			Years map[string]yearSummary `json:"years"`
		}{Years: make(map[string]yearSummary)}
		for i, year := range years {
			stage := "sync:" + year
			_ = hb(stage, 40+50*(i+1)/len(years))
			rows := byYear[year]
			if len(rows) == 0 {
				// The store's empty-replace no-op also covers a year upstream
				// genuinely has no rows for; skip the call entirely.
				out.Years[year] = yearSummary{Fetched: len(races), Upserted: 0, Deleted: 0}
				log.Info("chinaath_race_calendar_sync: year absent from catalogue",
					zap.String("job_id", j.ID),
					zap.String("year", year))
				continue
			}
			res, err := cfg.Store.ReplaceRaceCalendarYear(ctx, Source, year, rows)
			if err != nil {
				if storage.IsDeterministicWriteError(err) {
					log.Error("chinaath_race_calendar_sync: year write failed (deterministic)",
						zap.String("job_id", j.ID),
						zap.String("year", year),
						zap.String("error_code", "storage_constraint"),
						zap.Error(err))
					return "", job.NewPermanentError("storage_constraint", err)
				}
				log.Error("chinaath_race_calendar_sync: year write failed",
					zap.String("job_id", j.ID),
					zap.String("year", year),
					zap.Error(err))
				return "", err
			}
			out.Years[year] = yearSummary{Fetched: len(races), Upserted: res.Upserted, Deleted: res.Deleted}
			log.Info("chinaath_race_calendar_sync: year synced",
				zap.String("job_id", j.ID),
				zap.String("year", year),
				zap.Int("fetched", len(races)),
				zap.Int("upserted", res.Upserted),
				zap.Int("deleted", res.Deleted))
		}

		result, _ := json.Marshal(out)
		return string(result), nil
	}
}

// yearSummary is the per-year result reported in the job's result_json.
type yearSummary struct {
	Fetched  int `json:"fetched"`
	Upserted int `json:"upserted"`
	Deleted  int `json:"deleted"`
}

// jobInput is the job's input: {"years":[...]} optionally overrides which
// years to mirror.
type jobInput struct {
	Years []string `json:"years"`
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

// defaultYears is the current and next Shanghai year — the window a race
// calendar consumer cares about; the upstream catalogue also carries history.
func defaultYears() []string {
	y := timefmt.ShanghaiToday().Year()
	return []string{strconv.Itoa(y), strconv.Itoa(y + 1)}
}

// toRow maps one upstream competition into a race_calendar row: the Chinese
// race name fills both name and name_cn, the "省/市/区" address splits into
// province/city (the district level is dropped), the grade becomes the label,
// and the race items map onto the shared racetypes vocabulary.
func toRow(r chinaath.Race) storage.RaceCalendarEvent {
	province, city := splitAddress(r.RaceAddress)
	types, _ := json.Marshal(racetypes.FromChinaItems(r.Items))
	return storage.RaceCalendarEvent{
		Name:      r.RaceName,
		NameCN:    strPtrOrNil(r.RaceName),
		RaceDate:  r.RaceTime,
		Country:   "CHN",
		Province:  strPtrOrNil(province),
		City:      strPtrOrNil(city),
		Label:     strPtrOrNil(r.RaceGrade),
		RaceTypes: strPtrOrNil(string(types)),
	}
}

// splitAddress splits the upstream "省/市/区" address into its province and city
// parts (the district level is not persisted). Missing or empty parts degrade
// to "" and become NULL via strPtrOrNil.
func splitAddress(addr string) (province, city string) {
	parts := strings.Split(addr, "/")
	if len(parts) > 0 {
		province = strings.TrimSpace(parts[0])
	}
	if len(parts) > 1 {
		city = strings.TrimSpace(parts[1])
	}
	return province, city
}

// strPtrOrNil maps an empty string to a nil pointer (NULL in MySQL).
func strPtrOrNil(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}
