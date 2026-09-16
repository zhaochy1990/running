package job

import (
	"context"
	"errors"
	"sync/atomic"
	"time"

	"go.uber.org/zap"

	"github.com/zhaochy1990/stride/internal/logging"
)

// RetryPolicy governs bounded retry + backoff before poisoning.
type RetryPolicy struct {
	MaxAttempts int
	BaseBackoff time.Duration
	MaxBackoff  time.Duration
}

// Dispatcher processes one pointer Message end to end: load the job, run its
// handler, and drive the terminal/retry/poison transition. It owns no transport
// loop — a Consumer feeds it Messages and acks after Dispatch returns nil.
type Dispatcher struct {
	store     Store
	registry  *Registry
	publisher Publisher
	lifecycle Lifecycle
	policy    RetryPolicy
	// lease is how long a running job may go without a renewal before another
	// worker may reclaim it. Zero disables renewal and reclaim (tests).
	lease time.Duration
	now   func() time.Time
	log   *zap.Logger

	// counters feed the worker heartbeat log (best-effort, monotonic).
	started   atomic.Int64
	completed atomic.Int64
	failed    atomic.Int64
}

// Stats is a monotonic snapshot of dispatch activity for the heartbeat log.
// Started counts jobs whose handler began; Completed and Failed count terminal
// outcomes (a retried job is neither until it finally succeeds or is poisoned).
type Stats struct {
	Started   int64
	Completed int64
	Failed    int64
}

// Stats returns a snapshot of the dispatch counters.
func (d *Dispatcher) Stats() Stats {
	return Stats{
		Started:   d.started.Load(),
		Completed: d.completed.Load(),
		Failed:    d.failed.Load(),
	}
}

// Option configures a Dispatcher.
type Option func(*Dispatcher)

// WithClock overrides the time source (tests).
func WithClock(now func() time.Time) Option { return func(d *Dispatcher) { d.now = now } }

// WithLogger sets the structured logger.
func WithLogger(l *zap.Logger) Option { return func(d *Dispatcher) { d.log = l } }

// WithLease sets the running-job lease used by the renewal heartbeat and the
// stale-running reclaim. Zero (the default) disables both.
func WithLease(lease time.Duration) Option { return func(d *Dispatcher) { d.lease = lease } }

// leaseRenewFraction divides the lease to get the renewal tick: a lease is
// renewed at a third of its span, so a live worker survives two missed ticks
// before another worker could reclaim its job.
const leaseRenewFraction = 3

// reclaimLimit caps how many stale jobs one sweep moves, so a large backlog is
// worked off across ticks instead of in one burst.
const reclaimLimit = 100

// durableWriteTimeout bounds a terminal state write that has been detached from
// a cancelled handler context (see durableCtx).
const durableWriteTimeout = 15 * time.Second

// NewDispatcher wires a Dispatcher. lifecycle may be NopLifecycle for standalone
// jobs; pass a pipeline orchestrator to advance/fail pipeline runs.
func NewDispatcher(store Store, reg *Registry, pub Publisher, lc Lifecycle, policy RetryPolicy, opts ...Option) *Dispatcher {
	d := &Dispatcher{
		store:     store,
		registry:  reg,
		publisher: pub,
		lifecycle: lc,
		policy:    policy,
		now:       func() time.Time { return time.Now().UTC() },
		log:       logging.Default(),
	}
	for _, o := range opts {
		o(d)
	}
	return d
}

// Dispatch handles one message. It returns nil when the message was handled and
// the caller should ack (this includes terminal failures and drops — they are
// "handled"). It returns a non-nil error only on an infrastructure fault the
// caller should treat as nack/requeue (e.g. the store is unreachable), so the
// broker will redeliver.
func (d *Dispatcher) Dispatch(ctx context.Context, m Message) error {
	j, err := d.store.Get(ctx, m.JobID)
	if err != nil {
		if IsNotFound(err) {
			// Orphan pointer (state deleted / never written): drop it.
			d.log.Warn("dropping orphan job message", zap.String("job_id", m.JobID), zap.String("user_id", m.UserID))
			return nil
		}
		return err // infra fault -> nack/requeue
	}

	if j.Status.Terminal() {
		// Terminal lifecycle work is replayed until durable pipeline state catches up.
		var lifecycleErr error
		if j.Status == StatusDone {
			lifecycleErr = d.lifecycle.OnJobCompleted(ctx, j)
		} else {
			lifecycleErr = d.lifecycle.OnJobFailed(ctx, j)
		}
		if lifecycleErr != nil {
			return lifecycleErr
		}
		d.log.Debug("job already terminal, dropping duplicate", zap.String("job_id", j.ID), zap.String("status", string(j.Status)))
		return nil
	}

	handler, ok := d.registry.Handler(j.Type)
	if !ok {
		d.log.Error("no handler for job type", zap.String("job_id", j.ID), zap.String("type", j.Type))
		return d.finishFailed(ctx, j, "no_handler", "no handler registered for job type "+j.Type)
	}

	// Claim is compare-and-swap in the durable store. Duplicate broker pointers
	// either observe terminal state above or lose this queued→running transition.
	j, claimed, err := d.store.Claim(ctx, j.ID, d.now())
	if err != nil {
		return err // infra fault -> redeliver
	}
	if !claimed {
		return nil
	}

	// Reflect the running state on the owning pipeline run (if any). Best-effort:
	// the job is already claimed, so a failure here is a display/telemetry gap,
	// not a reason to redeliver the message.
	if err := d.lifecycle.OnJobStarted(ctx, j); err != nil {
		d.log.Warn("lifecycle OnJobStarted failed; continuing claimed job",
			zap.String("job_id", j.ID),
			zap.Error(err),
		)
	}

	d.started.Add(1)
	d.log.Info("processing job",
		zap.String("job_id", j.ID),
		zap.String("type", j.Type),
		zap.String("user_id", j.UserID),
		zap.Int("attempt", j.Attempts),
	)

	hb := func(stage string, pct int) error {
		now := d.now()
		j.Stage = stage
		j.ProgressPct = pct
		j.UpdatedAt = now
		j.HeartbeatAt = &now
		return d.store.Update(ctx, j)
	}

	// Renew the job's lease for as long as this process is running the handler,
	// independent of handler progress, so a long silent fetch is still observably
	// alive to the stale-running reclaim running on other replicas.
	stopRenew := d.startLeaseRenewer(ctx, j.ID)
	result, herr := handler(ctx, j, hb)
	stopRenew()
	if herr == nil {
		return d.finishDone(ctx, j, result)
	}
	return d.handleFailure(ctx, j, m, herr)
}

// startLeaseRenewer refreshes jobID's lease on a ticker until the returned stop
// func is called. A non-positive lease disables renewal.
func (d *Dispatcher) startLeaseRenewer(ctx context.Context, jobID string) func() {
	if d.lease <= 0 {
		return func() {}
	}
	rctx, cancel := context.WithCancel(ctx)
	done := make(chan struct{})
	go func() {
		defer close(done)
		t := time.NewTicker(d.lease / leaseRenewFraction)
		defer t.Stop()
		for {
			select {
			case <-rctx.Done():
				return
			case <-t.C:
				now := d.now()
				// A renewal is a running→running CAS: it touches only heartbeat_at/
				// updated_at and refuses to act once another writer has moved the row
				// off running. ErrStateChanged just means the job left running.
				_, err := d.store.TransitionJob(rctx, jobID, JobTransition{
					From:        statusPtr(StatusRunning),
					To:          StatusRunning,
					HeartbeatAt: &now,
				})
				if err != nil && !errors.Is(err, ErrStateChanged) {
					d.log.Warn("lease renewal failed", zap.String("job_id", jobID), zap.Error(err))
				}
			}
		}
	}()
	return func() { cancel(); <-done }
}

// durableCtx detaches a durable state write from the handler's context and adds
// a short bound. A shutdown cancels the handler's context; without this the
// retry/terminal record would not persist and the job would be stranded in
// `running` until the lease reclaim (or forever, before that existed).
func durableCtx(ctx context.Context) (context.Context, context.CancelFunc) {
	return context.WithTimeout(context.WithoutCancel(ctx), durableWriteTimeout)
}

func (d *Dispatcher) finishDone(ctx context.Context, j *Job, result string) error {
	wctx, cancel := durableCtx(ctx)
	defer cancel()
	now := d.now()
	j.Status = StatusDone
	j.ProgressPct = 100
	j.ResultJSON = result
	j.ErrorCode = ""
	j.ErrorMessage = ""
	j.CompletedAt = &now
	j.UpdatedAt = now
	if err := d.store.Update(wctx, j); err != nil {
		return err
	}
	if err := d.lifecycle.OnJobCompleted(wctx, j); err != nil {
		// The job is durably done, but its pipeline transition or completion listener
		// is not. Nack so the terminal-message path can retry that idempotent work.
		return err
	}
	d.completed.Add(1)
	d.log.Info("job done", zap.String("job_id", j.ID), zap.String("type", j.Type), zap.Int("attempts", j.Attempts))
	return nil
}

func (d *Dispatcher) handleFailure(ctx context.Context, j *Job, m Message, herr error) error {
	if pe, ok := AsPermanent(herr); ok {
		return d.finishFailed(ctx, j, pe.Code, pe.Error())
	}
	wctx, cancel := durableCtx(ctx)
	defer cancel()

	decision := DecideFailure(j.Attempts, d.policy.MaxAttempts, d.policy.BaseBackoff, d.policy.MaxBackoff)
	switch decision.Outcome {
	case OutcomeRetry:
		j.Status = StatusQueued
		j.ErrorCode = "retryable"
		j.ErrorMessage = herr.Error()
		j.UpdatedAt = d.now()
		if err := d.store.Update(wctx, j); err != nil {
			return err
		}
		if err := d.publisher.PublishRetry(wctx, m, decision.Delay); err != nil {
			return err // could not schedule retry -> redeliver
		}
		d.log.Warn("job failed, scheduled retry", zap.String("job_id", j.ID), zap.Int("attempts", j.Attempts), zap.Duration("backoff", decision.Delay), zap.Error(herr))
		return nil
	default: // OutcomePoison
		if err := d.finishFailed(ctx, j, "poison", herr.Error()); err != nil {
			return err
		}
		if err := d.publisher.PublishPoison(wctx, m); err != nil {
			return err
		}
		d.log.Error("job poisoned", zap.String("job_id", j.ID), zap.Int("attempts", j.Attempts), zap.Error(herr))
		return nil
	}
}

func (d *Dispatcher) finishFailed(ctx context.Context, j *Job, code, msg string) error {
	wctx, cancel := durableCtx(ctx)
	defer cancel()
	now := d.now()
	j.Status = StatusFailed
	j.ErrorCode = code
	j.ErrorMessage = msg
	j.CompletedAt = &now
	j.UpdatedAt = now
	if err := d.store.Update(wctx, j); err != nil {
		return err
	}
	if err := d.lifecycle.OnJobFailed(wctx, j); err != nil {
		return err
	}
	d.failed.Add(1)
	return nil
}

// statusPtr returns a pointer to s, for a JobTransition guard field.
func statusPtr(s Status) *Status { return &s }

// ReclaimStale moves running jobs whose lease has expired out of running —
// requeued when attempts remain, failed when the budget is spent. It is the
// recovery path for a worker that died mid-job (deploy, OOM, node loss) and is
// safe to run on every replica: each row is a compare-and-set that re-checks
// the lease, so a worker that renewed after the scan is never disturbed. Jobs
// whose type this worker has no handler for (e.g. the TS plan jobs that share
// the table) are left to their own reconciler. Returns how many jobs it moved.
func (d *Dispatcher) ReclaimStale(ctx context.Context, lease time.Duration) (int, error) {
	if lease <= 0 {
		return 0, nil
	}
	now := d.now()
	cutoff := now.Add(-lease)
	stale, err := d.store.ListStaleRunning(ctx, cutoff, reclaimLimit)
	if err != nil {
		return 0, err
	}
	moved := 0
	for _, j := range stale {
		if _, ok := d.registry.Handler(j.Type); !ok {
			continue
		}
		var rerr error
		if j.Attempts >= d.policy.MaxAttempts {
			rerr = d.failStale(ctx, j, cutoff, now)
		} else {
			rerr = d.requeueStale(ctx, j, cutoff, now)
		}
		if rerr != nil {
			if errors.Is(rerr, ErrStateChanged) {
				continue // another replica moved it first
			}
			d.log.Warn("stale job reclaim skipped", zap.String("job_id", j.ID), zap.Error(rerr))
			continue
		}
		moved++
	}
	return moved, nil
}

// requeueStale re-enqueues a stale job that still has attempts remaining.
func (d *Dispatcher) requeueStale(ctx context.Context, j *Job, cutoff, now time.Time) error {
	if _, err := d.store.TransitionJob(ctx, j.ID, JobTransition{
		From:        statusPtr(StatusRunning),
		To:          StatusQueued,
		LeaseBefore: &cutoff,
		HeartbeatAt: &now,
	}); err != nil {
		return err
	}
	if err := d.publisher.PublishWork(ctx, Message{JobID: j.ID, UserID: j.UserID}); err != nil {
		// Queued without a pointer. Put it back to running with a fresh lease so
		// the next sweep retries instead of stranding it queued forever.
		if _, rerr := d.store.TransitionJob(ctx, j.ID, JobTransition{
			From:        statusPtr(StatusQueued),
			To:          StatusRunning,
			HeartbeatAt: &now,
		}); rerr != nil {
			d.log.Error("stale requeue publish failed and revert failed", zap.String("job_id", j.ID), zap.Error(rerr))
		}
		return err
	}
	d.log.Warn("stale job requeued", zap.String("job_id", j.ID), zap.String("type", j.Type), zap.Int("attempts", j.Attempts))
	return nil
}

// failStale terminally fails a stale job whose attempt budget is spent, and
// fails its owning run through the lifecycle.
func (d *Dispatcher) failStale(ctx context.Context, j *Job, cutoff, now time.Time) error {
	code := "stale_running"
	message := "worker lost mid-run and the attempt budget is spent"
	failed, err := d.store.TransitionJob(ctx, j.ID, JobTransition{
		From:         statusPtr(StatusRunning),
		To:           StatusFailed,
		LeaseBefore:  &cutoff,
		ErrorCode:    &code,
		ErrorMessage: &message,
		CompletedAt:  &now,
	})
	if err != nil {
		return err
	}
	// Fail the owning run. If the listener fails, republish the pointer so the
	// dispatcher's terminal-replay path retries it.
	if lerr := d.lifecycle.OnJobFailed(ctx, failed); lerr != nil {
		if perr := d.publisher.PublishWork(ctx, Message{JobID: failed.ID, UserID: failed.UserID}); perr != nil {
			return perr
		}
		d.log.Warn("stale job failed; lifecycle replay published", zap.String("job_id", failed.ID))
	}
	d.failed.Add(1)
	d.log.Warn("stale job failed", zap.String("job_id", failed.ID), zap.Int("attempts", failed.Attempts))
	return nil
}
