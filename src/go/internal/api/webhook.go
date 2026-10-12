// webhook.go serves the watch-provider event-push ingress (devops#287):
// POST /webhook/push/{provider}. The route is public — the caller is a watch
// provider's server (e.g. COROS pushing workout summaries, API Reference 5.3),
// not a STRIDE user or internal service — so it sits outside the JWT
// authenticator and each provider adapter verifies its own credentials from
// the request headers. The handler only verifies, records and enqueues; it
// never waits on anything slow. COROS replays on any non-"0000" result body
// for up to 24h, so transient failures must answer non-"0000" while permanent
// ones (unknown user) must answer "0000".
package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	"go.uber.org/zap"

	"github.com/zhaochy1990/stride/internal/job"
	"github.com/zhaochy1990/stride/internal/logging"
	"github.com/zhaochy1990/stride/internal/storage"
	"github.com/zhaochy1990/stride/internal/webhook"
)

// WebhookEventStore persists push events (satisfied by *storage.Store).
type WebhookEventStore interface {
	// CreateProviderEvent inserts the event; created=false means the
	// (provider, provider_activity_id) pair is already recorded (duplicate
	// push — already processed, skip its enqueue).
	CreateProviderEvent(ctx context.Context, ev *storage.ProviderEvent) (bool, error)
}

// ProviderUserResolver maps a provider-scoped account id (COROS openId) to the
// STRIDE user UUID through the auth-service OAuth binding. An empty userID
// means "not bound" (record the event, never retry it). The production
// cross-service implementation is a follow-up task; a nil resolver resolves
// nothing.
type ProviderUserResolver interface {
	ResolveProviderUser(ctx context.Context, provider, providerUserID string) (userID string, err error)
}

// webhookRoutes is the webhook registrar. One instance serves every provider
// through the adapter registry.
type webhookRoutes struct {
	adapters map[string]webhook.Adapter
	events   WebhookEventStore
	resolver ProviderUserResolver
	enq      Enqueuer
	// fetchJobType is the provider_activity_fetch job type, injected from
	// internal/catalog like WatchSyncJobType.
	fetchJobType string
	// enqueueEnabled gates enqueueing: the worker terminally fails unknown
	// job types, so the switch must stay off until the fetch handler ships.
	// Events are still recorded while off.
	enqueueEnabled bool
	log            *zap.Logger
}

func newWebhookRoutes(adapters map[string]webhook.Adapter, events WebhookEventStore, resolver ProviderUserResolver, enq Enqueuer, fetchJobType string, enqueueEnabled bool, log *zap.Logger) *webhookRoutes {
	if log == nil {
		log = logging.Default()
	}
	return &webhookRoutes{
		adapters:       adapters,
		events:         events,
		resolver:       resolver,
		enq:            enq,
		fetchJobType:   fetchJobType,
		enqueueEnabled: enqueueEnabled,
		log:            log,
	}
}

// register mounts the public push route directly on the engine (no JWT, no
// internal token). The body-size cap is the public-ingress hardening; webhook
// bodies are provider batch pushes, so it shares the API's request ceiling.
// Not mounted when no event store is wired (tests running a partial service).
func (w *webhookRoutes) register(r *gin.Engine) {
	if w.events == nil {
		return
	}
	g := r.Group("", limitBody(maxRequestBytes))
	g.POST("/webhook/push/:provider", w.push)
}

// webhookResult is the response body every branch answers with. COROS 5.3.4
// only inspects result: "0000" = accepted, anything else = retry the push.
type webhookResult struct {
	Result  string `json:"result"`
	Message string `json:"message"`
}

func (w *webhookRoutes) ok(c *gin.Context) {
	c.JSON(http.StatusOK, webhookResult{Result: "0000", Message: "ok"})
}

// fail answers a non-"0000" result with an HTTP status consistent with it
// (400→"0400", 5xx→"0500", …). Failures the provider can fix by re-pushing
// keep result non-zero so the push retries within its 24h window.
func (w *webhookRoutes) fail(c *gin.Context, status int, message string) {
	c.JSON(status, webhookResult{Result: fmt.Sprintf("%04d", status), Message: message})
}

// push handles one provider batch: read raw body first (archival + any future
// rawBody-verified provider), then resolve the adapter (404), verify its
// credentials (403), parse the batch (400), and per event: resolve the STRIDE
// user, record idempotently, enqueue the fetch for new bound events.
func (w *webhookRoutes) push(c *gin.Context) {
	provider := c.Param("provider")
	// Must precede any binding call: gin's body consumers drain the reader,
	// and the raw body is the archival record.
	raw, err := io.ReadAll(c.Request.Body)
	if err != nil {
		w.fail(c, http.StatusBadRequest, "unreadable request body")
		return
	}
	adapter, ok := w.adapters[provider]
	if !ok {
		w.log.Warn("webhook push from unknown provider", zap.String("provider", provider))
		w.fail(c, http.StatusNotFound, "unknown provider")
		return
	}
	if err := adapter.VerifyCredentials(c.Request.Header); err != nil {
		w.log.Warn("webhook push failed credential verification",
			zap.String("provider", provider), zap.Error(err))
		w.fail(c, http.StatusForbidden, "credential verification failed")
		return
	}
	events, err := adapter.ParseEvents(raw)
	if err != nil {
		w.fail(c, http.StatusBadRequest, err.Error())
		return
	}

	ctx := c.Request.Context()
	now := time.Now().UTC()
	created, duplicates, enqueued, unbound := 0, 0, 0, 0
	for _, ev := range events {
		userID := ""
		// Resolution only matters when a fetch could be enqueued; while the
		// enqueue switch is off (fetch handler not shipped) it would be a
		// per-event cross-service call with no consumer of its result.
		if w.enqueueEnabled && w.resolver != nil {
			userID, err = w.resolver.ResolveProviderUser(ctx, ev.Provider, ev.ProviderUserID)
			if err != nil {
				w.log.Error("webhook user resolution failed",
					zap.String("provider", ev.Provider),
					zap.String("provider_user_id", ev.ProviderUserID), zap.Error(err))
				w.fail(c, http.StatusInternalServerError, "user resolution failed")
				return
			}
		}
		row := &storage.ProviderEvent{
			Provider:           ev.Provider,
			ProviderUserID:     ev.ProviderUserID,
			ProviderActivityID: ev.ProviderActivityID,
			EventType:          ev.EventType,
			PlanWorkoutID:      strPtrOrNil(ev.PlanWorkoutID),
			FitURL:             strPtrOrNil(ev.FitURL),
			OccurTime:          ev.OccurTime,
			ReceivedAt:         now,
			UserID:             strPtrOrNil(userID),
			RawPayload:         raw,
		}
		isNew, err := w.events.CreateProviderEvent(ctx, row)
		if err != nil {
			w.log.Error("webhook event insert failed",
				zap.String("provider", ev.Provider),
				zap.String("provider_activity_id", ev.ProviderActivityID), zap.Error(err))
			w.fail(c, http.StatusInternalServerError, "event insert failed")
			return
		}
		if !isNew {
			duplicates++
			continue
		}
		created++
		if userID == "" || !w.enqueueEnabled {
			if userID == "" && w.enqueueEnabled {
				unbound++
				w.log.Warn("webhook push for unbound provider user",
					zap.String("provider", ev.Provider),
					zap.String("provider_user_id", ev.ProviderUserID),
					zap.String("provider_activity_id", ev.ProviderActivityID))
			}
			continue
		}
		input, err := json.Marshal(webhookFetchInput{EventID: row.ID})
		if err != nil {
			w.fail(c, http.StatusInternalServerError, "job input encode failed")
			return
		}
		_, err = w.enq.Enqueue(ctx, job.EnqueueSpec{
			Type:           w.fetchJobType,
			UserID:         userID,
			InputJSON:      string(input),
			IdempotencyKey: "webhook-" + ev.Provider + "-" + ev.ProviderActivityID,
		})
		if errors.Is(err, job.ErrConflict) {
			// Double insurance with the event unique index: the fetch job
			// already exists for this activity.
			continue
		}
		if err != nil {
			w.log.Error("webhook fetch enqueue failed",
				zap.String("provider", ev.Provider),
				zap.String("provider_activity_id", ev.ProviderActivityID), zap.Error(err))
			w.fail(c, http.StatusInternalServerError, "fetch enqueue failed")
			return
		}
		enqueued++
	}
	w.log.Info("webhook push accepted",
		zap.String("provider", provider),
		zap.Int("events", len(events)),
		zap.Int("created", created),
		zap.Int("duplicates", duplicates),
		zap.Int("enqueued", enqueued),
		zap.Int("unbound", unbound))
	w.ok(c)
}

// webhookFetchInput is the provider_activity_fetch job payload: it points at
// the provider_events row — the authoritative payload — instead of copying
// activity fields into the job.
type webhookFetchInput struct {
	EventID uint64 `json:"event_id"`
}
