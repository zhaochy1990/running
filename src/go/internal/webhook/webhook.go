// Package webhook is the watch-provider event-push domain (devops#287): the
// per-provider Adapter seam the receiving route depends on, and the normalized
// ProviderEvent an adapter's raw push body decodes into. The package owns no
// HTTP or storage logic — the route lives in internal/api, persistence in
// internal/storage — so adapters stay unit-testable without a server, database
// or real provider account.
package webhook

import (
	"net/http"
	"time"
)

// EventTypeActivityCreate is the only push semantics COROS 5.3 defines: a
// workout was recorded. There is no event-type field in the payload.
const EventTypeActivityCreate = "activity.create"

// Adapter is one watch provider's event-push dialect: how its requests are
// authenticated and how its body decodes into normalized events. It is the
// single test seam of the webhook surface — the route depends only on the
// registry (map[string]Adapter), never on a concrete provider.
type Adapter interface {
	// Provider is the registry key and the URL path segment the push address
	// carries (e.g. POST /webhook/push/coros).
	Provider() string

	// VerifyCredentials authenticates the request from its headers. COROS
	// sends its issued client/secret as plain header constants (5.3.1);
	// verification must be constant-time. An error fails the whole request
	// (403, nothing recorded, nothing enqueued).
	VerifyCredentials(headers http.Header) error

	// ParseEvents decodes a push body into one normalized event per activity.
	// Any single malformed item invalidates the whole batch (the provider
	// re-pushes batches atomically), so a per-item validation failure must
	// return an error rather than skip the item.
	ParseEvents(rawBody []byte) ([]ProviderEvent, error)
}

// ProviderEvent is one pushed activity summary, normalized across providers.
// It is an in-process value: it is persisted (mapped onto a
// storage.ProviderEvent row with the whole raw body) and then discarded — the
// queued job references the stored row, not this struct, so activity fields
// never exist in two places.
type ProviderEvent struct {
	Provider           string
	ProviderUserID     string    // COROS openId
	ProviderActivityID string    // COROS labelId
	EventType          string    // always activity.create for now
	OccurTime          time.Time // activity end, UTC
	PlanWorkoutID      string    // optional; empty = not from a pushed plan workout
	FitURL             string    // empty for multisport pushes (FIT urls live on child items)
}
