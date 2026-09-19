package competitioncalendar

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/zhaochy1990/stride/internal/job"
	"github.com/zhaochy1990/stride/internal/worldathletics"
)

// KeyJobType is the registered job_type for the key-discovery handler.
const KeyJobType = "fetch_wa_api_key"

// DefaultSitePageURL is the World Athletics page whose shared JS bundle carries
// the public AppSync config (endpoint + API key). Any WA page works (the config
// chunk is in the common layout); this is the calendar page the pipeline serves.
const DefaultSitePageURL = "https://worldathletics.org/competitions/world-athletics-label-road-races/calendar-results"

// NewKeyFetcher returns the fetch_wa_api_key job.Handler: it discovers the
// current AppSync endpoint + API key from the WA site's JS bundle, verifies the
// key authenticates with a tiny GraphQL probe, and returns
// {"endpoint":...,"api_key":...} for the calendar step. pageURL names the page
// to scan (DefaultSitePageURL in production; a test server in tests).
//
// It is the first step of the competition_calendar_sync pipeline with
// ContinueOnFailure: on any failure the next step falls back to the configured
// key, so key-rotation self-healing never blocks a calendar sync; the failed
// step stays visible on the run.
func NewKeyFetcher(client *worldathletics.Client, pageURL string) job.Handler {
	return func(ctx context.Context, j *job.Job, hb job.Heartbeat) (string, error) {
		info, err := client.DiscoverAPIKey(ctx, pageURL)
		if err != nil {
			// The site restructured and the config can no longer be located:
			// deterministic, retrying discovery won't help.
			if errors.Is(err, worldathletics.ErrAPIKeyNotFound) {
				return "", job.NewPermanentError("api_key_not_found", err)
			}
			// Page/chunk fetch failure (network, 5xx) -> retryable.
			return "", err
		}

		if err := client.VerifyAPIKey(ctx, info.Endpoint, info.APIKey); err != nil {
			// The discovered key didn't authenticate: deterministic for that key.
			if errors.Is(err, worldathletics.ErrProbeRejected) {
				return "", job.NewPermanentError("api_key_verify_failed", err)
			}
			// Probe transport failure -> retryable.
			return "", err
		}

		_ = hb("discover", 100)
		out, _ := json.Marshal(map[string]string{"endpoint": info.Endpoint, "api_key": info.APIKey})
		return string(out), nil
	}
}
