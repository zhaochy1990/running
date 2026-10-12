package webhook

import (
	"crypto/subtle"
	"encoding/json"
	"fmt"
	"net/http"
	"time"
)

// corosProviderKey is the COROS registry key and URL path segment.
const corosProviderKey = "coros"

// Coros multisport parent modes (workout-type table, 5.3.3): 13 covers
// triathlon/multisport/ski-touring/outdoor-climb parents and 14 mountain
// climb. These push no top-level fitUrl — the .fit downloads live on each
// triathlonItemList child item.
var corosMultisportModes = map[int]bool{13: true, 14: true}

// CorosAdapter implements Adapter for COROS open-platform workout-summary
// pushes (COROS API Reference 5.3). Credentials are the client/secret pair
// COROS issues; they arrive as plain header constants on every push and are
// compared in constant time.
type CorosAdapter struct {
	client string
	secret string
}

// NewCorosAdapter wires the adapter with COROS-issued credentials. Empty
// credentials never verify (and cmd does not register such an adapter).
func NewCorosAdapter(client, secret string) *CorosAdapter {
	return &CorosAdapter{client: client, secret: secret}
}

// Provider implements Adapter.
func (a *CorosAdapter) Provider() string { return corosProviderKey }

// VerifyCredentials implements Adapter: both header constants must match the
// configured pair (5.3.1 — there is no HMAC/challenge flow).
func (a *CorosAdapter) VerifyCredentials(headers http.Header) error {
	if !constantTimeHeaderEquals(headers.Get("client"), a.client) ||
		!constantTimeHeaderEquals(headers.Get("secret"), a.secret) {
		return fmt.Errorf("client/secret verification failed")
	}
	return nil
}

// constantTimeHeaderEquals compares a header value against an expected
// constant without leaking its content through timing. An empty expected
// value matches nothing.
func constantTimeHeaderEquals(got, want string) bool {
	if want == "" || got == "" {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(got), []byte(want)) == 1
}

// corosPushBody is the top-level 5.3.3 shape: a batch of workout summaries.
// Fields STRIDE does not consume (deviceName, step, duration,
// triathlonItemList) are deliberately not modeled — encoding/json ignores
// them, and the whole body is retained verbatim in the stored event's
// raw_payload. duration is the one required-table omission worth noting: the
// parameter table does not list it (only triathlon children have it) yet
// every JSON example carries it, so not modeling it also means a push without
// it is never rejected.
type corosPushBody struct {
	SportDataList []corosSportData `json:"sportDataList"`
}

// corosSportData is one workout summary. Required fields are pointers so a
// missing key is distinguishable from a zero value.
type corosSportData struct {
	OpenID        string   `json:"openId"`
	LabelID       string   `json:"labelId"`
	Mode          *int     `json:"mode"`
	SubMode       *int     `json:"subMode"`
	Distance      *float64 `json:"distance"`
	Calorie       *float64 `json:"calorie"`
	AvgSpeed      *float64 `json:"avgSpeed"`
	AvgFrequency  *float64 `json:"avgFrequency"`
	StartTime     *int64   `json:"startTime"`
	EndTime       *int64   `json:"endTime"`
	StartTimezone *int     `json:"startTimezone"`
	EndTimezone   *int     `json:"endTimezone"`
	FitURL        string   `json:"fitUrl"`
	PlanWorkoutID string   `json:"planWorkoutId"`
}

// ParseEvents implements Adapter: decodes sportDataList and validates every
// item. One invalid item rejects the batch (COROS re-pushes whole batches).
func (a *CorosAdapter) ParseEvents(rawBody []byte) ([]ProviderEvent, error) {
	var body corosPushBody
	if err := json.Unmarshal(rawBody, &body); err != nil {
		return nil, fmt.Errorf("coros: decode push body: %w", err)
	}
	if body.SportDataList == nil {
		return nil, fmt.Errorf("coros: push body has no sportDataList")
	}
	events := make([]ProviderEvent, 0, len(body.SportDataList))
	for i, item := range body.SportDataList {
		if err := validateCorosItem(i, item); err != nil {
			return nil, err
		}
		events = append(events, ProviderEvent{
			Provider:           corosProviderKey,
			ProviderUserID:     item.OpenID,
			ProviderActivityID: item.LabelID,
			EventType:          EventTypeActivityCreate,
			OccurTime:          time.Unix(*item.EndTime, 0).UTC(),
			PlanWorkoutID:      item.PlanWorkoutID,
			FitURL:             item.FitURL,
		})
	}
	return events, nil
}

// validateCorosItem enforces the 5.3.3 parameter table's required fields.
// fitUrl is required except for multisport parents (13/14), whose FIT files
// live on triathlonItemList children. triathlonItemList children are not
// validated here: they are retained verbatim and consumed by the fetch job.
func validateCorosItem(idx int, item corosSportData) error {
	missing := func(field string) error {
		return fmt.Errorf("coros: sportDataList[%d]: missing required field %s", idx, field)
	}
	switch {
	case item.OpenID == "":
		return missing("openId")
	case item.LabelID == "":
		return missing("labelId")
	case item.Mode == nil:
		return missing("mode")
	case item.SubMode == nil:
		return missing("subMode")
	case item.Distance == nil:
		return missing("distance")
	case item.Calorie == nil:
		return missing("calorie")
	case item.AvgSpeed == nil:
		return missing("avgSpeed")
	case item.AvgFrequency == nil:
		return missing("avgFrequency")
	case item.StartTime == nil:
		return missing("startTime")
	case item.EndTime == nil:
		return missing("endTime")
	case item.StartTimezone == nil:
		return missing("startTimezone")
	case item.EndTimezone == nil:
		return missing("endTimezone")
	case !corosMultisportModes[*item.Mode] && item.FitURL == "":
		return missing("fitUrl")
	}
	return nil
}
