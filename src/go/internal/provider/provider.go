// Package provider is the pluggable boundary between the sync worker / future
// API server and the watch-data adapters (COROS today; Garmin/Polar/Suunto
// later). It is the Go port of Python stride_core.source.
//
// Adapters implement Provider (typically by embedding BaseProvider) and declare
// which OPTIONAL features they support via Info().Capabilities. Provider-specific
// encodings are translated to the normalized domain inside each adapter; nothing
// above this boundary sees provider quirks.
//
// Required methods every adapter must implement: Info, IsLoggedIn, Login,
// SyncUser, ResyncActivity. The remaining methods are optional and
// capability-gated — embed BaseProvider to inherit FeatureNotSupported defaults.
package provider

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
)

// ─────────────────────────────────────────────────────────────────────────────
// Sync progress + result
// ─────────────────────────────────────────────────────────────────────────────

// SyncProgress is a free-form progress event emitted during a sync run.
type SyncProgress = map[string]any

// ProgressCallback receives incremental progress events. It may be nil.
type ProgressCallback func(SyncProgress)

// EmitProgress sends a {phase, current, total, percent} event if cb is non-nil.
// Shared by every provider adapter so the job row shows uniform sync progress.
func EmitProgress(cb ProgressCallback, phase string, current, total, percent int) {
	if cb == nil {
		return
	}
	cb(SyncProgress{"phase": phase, "current": current, "total": total, "percent": percent})
}

// PercentInBand maps current/total onto the [lo, hi] percent band for a sync
// phase (e.g. activities 10→80, health 80→95). A zero total yields lo.
func PercentInBand(current, total, lo, hi int) int {
	if total <= 0 {
		return lo
	}
	if current > total {
		current = total
	}
	return lo + (hi-lo)*current/total
}

// SyncMode is the DEPTH axis of a sync: how far back the activity scan and the
// daily-health window reach.
type SyncMode string

const (
	// SyncIncremental stops the activity scan at the first already-synced
	// activity (fast catch-up) and refreshes only the short daily-health
	// window. It is the default.
	SyncIncremental SyncMode = "incremental"
	// SyncFull re-scans the entire activity history (re-fetching details) and
	// walks the deep daily-health window.
	SyncFull SyncMode = "full"
)

// SyncContent is the CONTENT axis of a sync: which data domains to pull. It is a
// bitmask so callers can combine domains (default ContentAll).
type SyncContent uint8

const (
	// ContentActivities covers activities + laps + timeseries + watch zones.
	ContentActivities SyncContent = 1 << iota
	// ContentHealth covers daily_health + dashboard + daily_hrv + race_predictions.
	ContentHealth
	// ContentSchedule covers the third-party watch schedule (watch-schedule/v1).
	ContentSchedule
	// ContentAll is every domain.
	ContentAll = ContentActivities | ContentHealth | ContentSchedule
)

// Has reports whether c includes domain d.
func (c SyncContent) Has(d SyncContent) bool { return c&d != 0 }

// SyncOptions controls a sync run. Mode is the depth axis for both the activity
// scan and the daily-health window (SyncFull reaches back further than
// SyncIncremental for each). A zero Content is treated as ContentAll by SyncUser
// implementations. Limit caps the number of activities fetched (0 = unlimited) —
// useful for bounded validation runs.
//
// Jobs is the detail-fetch concurrency (number of parallel COROS detail
// requests). It is an infrastructure knob supplied by the CLI/worker from
// configuration, NOT part of the SyncOptionsInput API contract, so external
// callers cannot dictate server-side concurrency. A non-positive value means
// "adapter default".
type SyncOptions struct {
	Mode     SyncMode
	Content  SyncContent
	Limit    int
	Jobs     int
	Progress ProgressCallback
}

// DetailJobs bounds adapter-side fetch concurrency. A non-positive configured
// value uses the production default; the cap prevents accidental request floods.
func DetailJobs(jobs int) int {
	const defaultJobs = 4
	const maxJobs = 16
	switch {
	case jobs < 1:
		return defaultJobs
	case jobs > maxJobs:
		return maxJobs
	default:
		return jobs
	}
}

// SyncResult summarizes a sync run.
type SyncResult struct {
	Activities       int      // activities written/updated
	Health           int      // health-domain writes (daily_health + HRV + dashboard); display count
	ActivityLabelIDs []string // label_ids touched this run
	HealthDates      []string // Shanghai calendar dates whose daily_health rows were refreshed

	// Watch-schedule domain (ContentSchedule). Sessions is the count of run
	// sessions ingested; the Skipped* counters record content the puller
	// intentionally dropped so a sync can surface it as metadata.
	ScheduleSessions        int // run sessions written/updated
	ScheduleSkippedStrength int // strength sessions skipped (v1 models run only)
	ScheduleSkippedStride   int // [STRIDE]-authored sessions excluded (self-loop)
	ScheduleSkippedInvalid  int // running sessions that failed to decode
}

// SyncOptionsInput is the JSON contract for a sync request: the watch_sync job's
// InputJSON and the POST /api/{user}/sync request body both use it. It is the
// single source of truth for how a {mode, content, limit} blob maps onto
// SyncOptions, shared by the API edge (validation → 400) and the worker handler
// (parse → SyncOptions) so the two never drift.
//
// An empty Mode/Content means "take the sync default" (full + all); callers that
// want a different default (e.g. the manual-sync endpoint defaults to
// incremental) set Mode explicitly before validating.
type SyncOptionsInput struct {
	Mode    string `json:"mode,omitempty"`
	Content string `json:"content,omitempty"`
	Limit   int    `json:"limit,omitempty"`
}

// Validate reports whether the input's enums and limit are acceptable, without
// mutating it. It is the edge check the API runs to return a clean 400.
func (in SyncOptionsInput) Validate() error {
	switch in.Mode {
	case "", string(SyncFull), string(SyncIncremental):
	default:
		return fmt.Errorf("invalid mode %q", in.Mode)
	}
	switch in.Content {
	case "", "all", "activities", "health", "schedule":
	default:
		return fmt.Errorf("invalid content %q", in.Content)
	}
	if in.Limit < 0 {
		return fmt.Errorf("limit must be >= 0, got %d", in.Limit)
	}
	return nil
}

// Options maps a validated input onto SyncOptions, applying the sync defaults
// (Mode=full, Content=all) for empty fields.
func (in SyncOptionsInput) Options() (SyncOptions, error) {
	if err := in.Validate(); err != nil {
		return SyncOptions{}, err
	}
	opts := SyncOptions{Mode: SyncFull, Content: ContentAll, Limit: in.Limit}
	if in.Mode == string(SyncIncremental) {
		opts.Mode = SyncIncremental
	}
	switch in.Content {
	case "activities":
		opts.Content = ContentActivities
	case "health":
		opts.Content = ContentHealth
	case "schedule":
		opts.Content = ContentSchedule
	}
	return opts, nil
}

// ParseSyncOptions parses a watch_sync InputJSON blob into SyncOptions. An
// absent/empty blob defaults to full + all + unlimited. Invalid JSON or an
// invalid enum/limit is an error (the worker treats it as a permanent bad
// payload).
func ParseSyncOptions(input string) (SyncOptions, error) {
	var in SyncOptionsInput
	if strings.TrimSpace(input) != "" {
		if err := json.Unmarshal([]byte(input), &in); err != nil {
			return SyncOptions{}, fmt.Errorf("parse payload: %w", err)
		}
	}
	return in.Options()
}

// ─────────────────────────────────────────────────────────────────────────────
// Recent-range sync (onboarding first-sync stage, epic devops#1004 T03/T04)
// ─────────────────────────────────────────────────────────────────────────────

// DayWindow is an inclusive natural-day range (YYYY-MM-DD, Shanghai calendar).
type DayWindow struct {
	From string
	To   string
}

// Recent-range channel outcome statuses. A channel that reached no terminal
// outcome is simply absent from the report — the executor treats absence as
// "still failed/unfinished", never as success.
const (
	// RangeChannelDone: the channel's complete fetch succeeded over its window.
	RangeChannelDone = "done"
	// RangeChannelGap: the fetch finished, but part of the window is
	// absent at the provider — either an honest empty period or an
	// explicitly unavailable record. Neither supplies coverage evidence.
	RangeChannelGap = "gap"
)

type RangeGapKind string

const (
	RangeGapEmpty       RangeGapKind = "empty"
	RangeGapTransient   RangeGapKind = "transient"
	RangeGapUnavailable RangeGapKind = "unavailable"
)

// RangeGap reports absent data within an inclusive Shanghai-day range.
// HealthHistoryDays is the lookback supplied by a COROS health response,
// when this gap precedes the oldest day in that response.
type RangeGap struct {
	From              string       `json:"from"`
	To                string       `json:"to"`
	Kind              RangeGapKind `json:"kind"`
	Channel           string       `json:"channel,omitempty"`
	ActivityID        string       `json:"activity_id,omitempty"`
	Reason            string       `json:"reason,omitempty"`
	HealthHistoryDays int          `json:"health_history_days,omitempty"`
	RangeEstimated    bool         `json:"range_estimated,omitempty"`
}

// Classified fills the kind for pre-classification records. Only explicitly
// known empty reasons qualify, including old flattened work-item reasons.
func (g RangeGap) Classified() RangeGap {
	if g.Channel == "" {
		channel, _, _ := strings.Cut(g.Reason, ": ")
		switch channel {
		case "activities", "health", "dashboard":
			g.Channel = channel
		default:
			switch {
			case strings.HasPrefix(g.Reason, "no activities"):
				g.Channel = "activities"
			case strings.HasPrefix(g.Reason, "provider returned no health rows"):
				g.Channel = "health"
			case strings.HasPrefix(g.Reason, "provider returned no dashboard summary"):
				g.Channel = "dashboard"
			}
		}
	}
	switch g.Kind {
	case RangeGapEmpty, RangeGapTransient, RangeGapUnavailable:
		return g
	}
	g.Kind = RangeGapEmpty
	for _, reason := range strings.Split(g.Reason, "; ") {
		_, detail, prefixed := strings.Cut(reason, ": ")
		if prefixed {
			reason = detail
		}
		switch reason {
		case "no activities at provider in range", "no activities in window",
			"provider returned no health rows for range", "provider returned no health rows for day",
			"provider returned no health rows", "provider returned no dashboard summary":
		default:
			g.Kind = RangeGapUnavailable
			return g
		}
	}
	return g
}

// HealthLookbackDays measures the observed lookback only for a current batch.
// Stale data supplying a few old dates cannot establish a recent history span.
func HealthLookbackDays(from, latest, targetTo string) int {
	start, startErr := time.Parse(time.DateOnly, from)
	end, endErr := time.Parse(time.DateOnly, latest)
	target, targetErr := time.Parse(time.DateOnly, targetTo)
	if startErr != nil || endErr != nil || targetErr != nil || end.Before(target.AddDate(0, 0, -1)) {
		return 0
	}
	return max(0, int(end.Sub(start).Hours()/24)+1)
}

// MergeRangeGaps combines previously recorded evidence with a new report.
func MergeRangeGaps(running, chunk []RangeGap) []RangeGap {
	seen := make(map[RangeGap]bool, len(running)+len(chunk))
	for _, gap := range running {
		seen[gap.Classified()] = true
	}
	for _, gap := range chunk {
		gap = gap.Classified()
		if !seen[gap] {
			seen[gap] = true
			running = append(running, gap)
		}
	}
	return running
}

// RememberRejectedActivities excludes terminal detail rejections from repeat
// list walks while leaving the records absent from observed coverage.
func RememberRejectedActivities(ids map[string]bool, gaps []RangeGap) {
	for _, gap := range gaps {
		if gap.Kind == RangeGapUnavailable && gap.ActivityID != "" {
			ids[gap.ActivityID] = true
		}
	}
}

// HasBlockingRangeGaps distinguishes a finished scan with expected blanks
// from one with data that could not be obtained.
func HasBlockingRangeGaps(gaps []RangeGap) bool {
	for _, g := range gaps {
		if g.Classified().Kind != RangeGapEmpty {
			return true
		}
	}
	return false
}

// IsRangeRejection reports an explicit provider refusal for a requested
// record or window. Auth and transport errors follow their separate paths.
func IsRangeRejection(err error) bool {
	var unsupported *FeatureNotSupported
	return IsInvalidRequest(err) || errors.As(err, &unsupported)
}

// RangeFetchError narrows an unsuccessful request to the window it failed on.
type RangeFetchError struct {
	Window DayWindow
	Err    error
}

func (e *RangeFetchError) Error() string { return e.Err.Error() }
func (e *RangeFetchError) Unwrap() error { return e.Err }

// RejectedRange records an explicit rejection without claiming the window
// was scanned. A caller must check IsRangeRejection before using it.
func RejectedRange(win DayWindow, err error) RangeGap {
	return RangeGap{From: win.From, To: win.To, Kind: RangeGapUnavailable, Reason: err.Error()}
}

// RangeCredentialObservedWindow reads the shared v1 proof format used by
// Garmin and COROS. A credential may have optional accounting suffixes.
func RangeCredentialObservedWindow(credential string) (from, to string, ok bool) {
	parts := strings.Split(credential, ":")
	if len(parts) < 7 || parts[1] != "v1" || parts[2] != "range" {
		return "", "", false
	}
	rangeLabel, ok := strings.CutPrefix(parts[5], "obs=")
	if !ok {
		return "", "", false
	}
	from, to, ok = strings.Cut(rangeLabel, "..")
	return from, to, ok && len(from) == len(time.DateOnly) && len(to) == len(time.DateOnly)
}

// RangeChannelReport is one data channel's terminal outcome. Scanned* is what
// the scan walked; Observed* is the window data actually exists for (nil when
// nothing was observed); Credential is the complete-fetch proof a retry reuses
// instead of re-fetching (opaque to the caller, written only on done/gap).
type RangeChannelReport struct {
	// Status is one of RangeChannelDone / RangeChannelGap.
	Status       string
	ScannedFrom  string
	ScannedTo    string
	ObservedFrom *string
	ObservedTo   *string
	Gaps         []RangeGap
	Credential   string
	// Count is a display-only tally (activities written / health days
	// refreshed / dashboard row written).
	Count int
}

// RecentRangeOptions selects which channels a recent-range sync runs, with
// each channel's server-chosen Shanghai-day window. A nil window skips the
// channel. The provider may legitimately return MORE data than the window
// (e.g. a batch health payload covering 90 days against a 28-day target): the
// extra rows are kept and the report's observed window reflects the actual
// coverage — never trimmed to the target, never widened beyond what the
// vendor really returned.
//
// Jobs is the detail-fetch concurrency, an infra knob supplied by the caller
// (CLI/worker) exactly like SyncOptions.Jobs — never client-controlled.
type RecentRangeOptions struct {
	Activities          *DayWindow
	Health              *DayWindow
	Dashboard           *DayWindow
	RejectedActivityIDs map[string]bool // terminal detail rejections from earlier attempts
	Jobs                int
}

// RecentRangeReport carries the terminal outcomes of a recent-range sync.
// Only channels that reached a terminal outcome appear; the returned error
// (if any) explains the first channel that failed non-permanently-skipping.
type RecentRangeReport struct {
	Activities *RangeChannelReport
	Health     *RangeChannelReport
	Dashboard  *RangeChannelReport
}

// ErrUnrecoverableRangeData marks range-sync input the provider confirmed
// exists but whose data cannot be classified — e.g. a Garmin activity whose
// start date is invalid even in its detail payload (devops#1007: 无效日期需
// 详情确认或明确阻塞). Retrying cannot fix it; the executor fails the job
// permanently instead of burning the retry budget.
var ErrUnrecoverableRangeData = errors.New("provider: unrecoverable range data")

// RecentSyncer is the optional adapter contract the onboarding recent-stage
// executor consumes (devops#1004 T03/T04). It is deliberately separate from
// Provider/SyncUser: the full/incremental depth axis cannot express "scan this
// exact window, do not stop at already-known activities, and report what was
// actually covered".
type RecentSyncer interface {
	// SyncRecentRange fetches the requested channels over their windows and
	// persists through the adapter's storage.Writer exactly like SyncUser
	// (ordered commits; a publish session in ctx fences activity writes).
	// Retryable errors (network, throttling, auth expiry surfaced by the
	// client) return the error; channels that already reached a terminal
	// outcome before the failure stay in the report so the caller can record
	// their credentials. Permanent provider rejections (auth, invalid
	// request) classify via IsAuthError / IsInvalidRequest as everywhere
	// else.
	SyncRecentRange(ctx context.Context, user string, opts RecentRangeOptions, progress ProgressCallback) (RecentRangeReport, error)
}

// ─────────────────────────────────────────────────────────────────────────────
// Chunked background backfill (onboarding follow-on stages, devops#1010 T06)
// ─────────────────────────────────────────────────────────────────────────────

// Backfill budget defaults (devops#1010 AC2): each chunk fetches at most ~20
// activity details or walks at most 7 health days, then checkpoints and
// yields the per-user execution lease so recent stages, new trainings and
// webhooks can jump the queue between chunks. The soft wall-clock budget is a
// safety net for pathologically slow fetches — reaching it mid-channel
// checkpoints what completed and yields exactly like the fetch budget.
const (
	DefaultBackfillActivityFetches = 20
	DefaultBackfillHealthDays      = 7
	DefaultBackfillSoftBudget      = 2 * time.Minute
)

// BackfillBudget caps one backfill chunk. Zero fields fall back to the
// package defaults; Soft <= 0 disables the wall-clock safety net (tests).
type BackfillBudget struct {
	MaxActivityFetches int
	MaxHealthDays      int
	Soft               time.Duration
}

// BackfillRangeOptions selects the channels of one backfill chunk. The
// checkpoints are the OPAQUE cursors the previous chunk of the same channel
// returned ("" = start from the window's newest day): storage treats them as
// blobs; only the owning adapter interprets them. A nil window skips the
// channel.
type BackfillRangeOptions struct {
	Activities           *DayWindow
	Health               *DayWindow
	ActivitiesCheckpoint string
	RejectedActivityIDs  map[string]bool // terminal detail rejections recorded by previous attempts or chunks
	HealthCheckpoint     string
	Budget               BackfillBudget
	Jobs                 int
}

// ChannelBackfillReport is one channel's chunk outcome. Done=true means the
// channel's window was fully walked AND reconciled this chunk — Checkpoint is
// empty and the executor derives the terminal coverage from what the store
// actually holds (observed windows and honest gaps never depend on chunk
// bookkeeping). Done=false carries the next Checkpoint; a chunk that neither
// advances the checkpoint nor completes reports Advanced=false so the caller
// can fail instead of spinning (AC4 不无限空转).
type ChannelBackfillReport struct {
	Done       bool
	Rejected   bool // requested window was refused before the scan could complete
	Checkpoint string
	// ScannedThrough is the newest-to-oldest walk's current depth (Shanghai
	// day, YYYY-MM-DD): everything in (ScannedThrough, window.To] is walked.
	// The executor surfaces it as the stage's running scanned window.
	ScannedThrough string
	// Fetches counts this chunk's activity detail downloads; DaysWalked its
	// health days (display/telemetry only — the budget enforcement is the
	// adapter's, the accounting is the caller's).
	Fetches    int
	DaysWalked int
	Advanced   bool
	// GapEvents are per-item/per-day missing-data notes observed
	// this chunk (rejected activities, undatable entries, honestly-empty
	// health days) the executor merges into the channel's running gap record.
	GapEvents []RangeGap
}

// BackfillRangeReport carries the chunk outcomes; only requested channels
// appear.
type BackfillRangeReport struct {
	Activities *ChannelBackfillReport
	Health     *ChannelBackfillReport
}

// BackfillSyncer is the optional chunked-range contract the onboarding
// extended/historical stages consume (devops#1010). It differs from
// RecentSyncer in two ways the background path needs and the interactive
// recent path must not pay: the run is BOUNDED (one chunk per call, budget
// above) and it RESUMES from an opaque checkpoint instead of restarting the
// walk. Inside a chunk the semantics match the recent scan: never stop the
// walk at already-stored activities as a coverage proof (existence only skips
// the re-fetch), verify ordering before any early stop, and commit through
// the same fenced ordered publish path.
type BackfillSyncer interface {
	SyncBackfillRange(ctx context.Context, user string, opts BackfillRangeOptions, progress ProgressCallback) (BackfillRangeReport, error)
}

// ─────────────────────────────────────────────────────────────────────────────
// Capabilities & provider info
// ─────────────────────────────────────────────────────────────────────────────

// Capability is an OPTIONAL feature an adapter may support. Required features
// (sync activities, sync basic health, auth, resync) are never capabilities —
// every adapter must implement them.
type Capability string

const (
	CapSyncHRVDetail       Capability = "sync_hrv_detail"   // daily HRV trend vs only nightly snapshot
	CapSyncSleep           Capability = "sync_sleep"        //
	CapSyncBodyBattery     Capability = "sync_body_battery" // Garmin-style readiness gauge
	CapPushRunWorkout      Capability = "push_run_workout"
	CapPushStrengthWorkout Capability = "push_strength_workout"
	CapDeleteWorkout       Capability = "delete_workout"
	CapQuerySchedule       Capability = "query_schedule"
	CapExerciseCatalog     Capability = "exercise_catalog"
	CapCustomExercise      Capability = "custom_exercise"
	CapWriteSportNote      Capability = "write_sport_note" // most APIs are read-only for notes
)

// Capabilities is the set of features a provider advertises.
type Capabilities map[Capability]bool

// Has reports whether the capability is declared.
func (c Capabilities) Has(cap Capability) bool { return c[cap] }

// ProviderInfo is a static description of an adapter.
type ProviderInfo struct {
	Name         string       // canonical lowercase: "coros", "garmin"
	DisplayName  string       // localized: "高驰", "佳明"
	Regions      []string     // supported login regions, e.g. {"global","cn","eu"}
	Capabilities Capabilities // declared optional features
}

// ─────────────────────────────────────────────────────────────────────────────
// Auth
// ─────────────────────────────────────────────────────────────────────────────

// LoginCredentials is a provider-agnostic login payload. Extra is an escape
// hatch for provider-specific bits (Garmin SSO ticket, MFA token, etc.).
type LoginCredentials struct {
	Email    string
	Password string
	Region   string
	Extra    map[string]any
}

// LoginResult is the outcome of a login call. Tokens are persisted adapter-side.
type LoginResult struct {
	Success bool
	UserID  string
	Region  string
	Message string
}

// ─────────────────────────────────────────────────────────────────────────────
// Schedule queries (read-side companion to Push*Workout)
// ─────────────────────────────────────────────────────────────────────────────

// ScheduledWorkoutSummary is a lightweight summary of a workout already on the
// watch's schedule.
type ScheduledWorkoutSummary struct {
	Date              string // ISO YYYY-MM-DD
	Name              string
	Sport             string // NormalizedSport value
	ProviderWorkoutID string // watch-side ID
	IsStrideManaged   bool   // heuristic: name has the "[STRIDE]" prefix
}

// RunWorkout / StrengthWorkout (the normalized workout specs) live in
// workout_spec.go — the Go port of stride_core.workout_spec. The Provider
// methods below consume those provider-agnostic specs; adapters translate them
// to provider payloads at push time.

// ─────────────────────────────────────────────────────────────────────────────
// Errors
// ─────────────────────────────────────────────────────────────────────────────

// FeatureNotSupported is returned when an adapter is asked to do something its
// capabilities don't include. Inspect it with errors.As.
type FeatureNotSupported struct {
	Provider   string
	Capability Capability
}

func (e *FeatureNotSupported) Error() string {
	return fmt.Sprintf("%q does not support %q", e.Provider, e.Capability)
}

// ErrAuthRequired is returned when a call is made for a user without valid
// credentials.
var ErrAuthRequired = errors.New("auth required")

// ErrInvalidRequest marks a provider-side parameter rejection that cannot be
// repaired by retrying the same request.
var ErrInvalidRequest = errors.New("invalid provider request")

// IsInvalidRequest reports whether a provider rejected deterministic request
// parameters. Retrying the same request cannot repair it.
func IsInvalidRequest(err error) bool {
	return errors.Is(err, ErrInvalidRequest)
}

// IsAuthError reports whether err is (or wraps) ErrAuthRequired — any
// authentication failure that retrying won't fix. Provider adapters tie their
// own auth errors to this sentinel via Unwrap (e.g. coros.AuthError).
func IsAuthError(err error) bool {
	return errors.Is(err, ErrAuthRequired)
}

// ─────────────────────────────────────────────────────────────────────────────
// Provider contract
// ─────────────────────────────────────────────────────────────────────────────

// Provider is the watch-data source adapter contract.
type Provider interface {
	Info() ProviderInfo

	// auth
	IsLoggedIn(user string) (bool, error) // local credential check, no network → no ctx
	Login(ctx context.Context, user string, creds LoginCredentials) (LoginResult, error)
	Logout(ctx context.Context, user string) error

	// sync
	SyncUser(ctx context.Context, user string, opts SyncOptions) (SyncResult, error)
	ResyncActivity(ctx context.Context, user, labelID string) (bool, error)

	// workout push (optional, capability-gated)
	PushRunWorkout(ctx context.Context, user string, w RunWorkout) (string, error)
	PushStrengthWorkout(ctx context.Context, user string, w StrengthWorkout) (string, error)
	DeleteScheduledWorkout(ctx context.Context, user, date, name string) (bool, error)
	QuerySchedule(ctx context.Context, user, start, end string) ([]ScheduledWorkoutSummary, error)
	PullWatchSchedule(ctx context.Context, user, start, end string) (WatchSchedulePull, error)

	// exercise catalog (optional, capability-gated)
	QueryExercises(ctx context.Context, user, sport string) ([]map[string]any, error)
	AddCustomExercise(ctx context.Context, user string, exercise map[string]any) (string, error)
}

// WorkoutDeleterByID is implemented by providers that can delete a pushed
// workout precisely by the watch-side id recorded at push time (Garmin;
// COROS deletes by date+name sweep via DeleteScheduledWorkout instead). The
// cmd-layer push adapter forwards this when the bound provider offers it.
type WorkoutDeleterByID interface {
	DeleteWorkoutByID(ctx context.Context, user, providerWorkoutID string) (bool, error)
}

// ─────────────────────────────────────────────────────────────────────────────
// BaseProvider — default optional impls
// ─────────────────────────────────────────────────────────────────────────────

// BaseProvider supplies default implementations of the optional, capability-
// gated methods (each returning *FeatureNotSupported) plus a no-op Logout. Embed
// it in a concrete adapter and implement the required methods (Info,
// IsLoggedIn, Login, SyncUser, ResyncActivity). Set Name so the default errors
// name the provider.
//
// Unlike Python's BaseDataSource, it does NOT stub the required methods, so Go
// enforces at compile time that every adapter implements them.
type BaseProvider struct {
	Name string
}

// Logout is a no-op by default; adapters override to clear local credentials or
// invalidate a server-side token.
func (b BaseProvider) Logout(context.Context, string) error { return nil }

func (b BaseProvider) PushRunWorkout(context.Context, string, RunWorkout) (string, error) {
	return "", &FeatureNotSupported{Provider: b.Name, Capability: CapPushRunWorkout}
}

func (b BaseProvider) PushStrengthWorkout(context.Context, string, StrengthWorkout) (string, error) {
	return "", &FeatureNotSupported{Provider: b.Name, Capability: CapPushStrengthWorkout}
}

func (b BaseProvider) DeleteScheduledWorkout(context.Context, string, string, string) (bool, error) {
	return false, &FeatureNotSupported{Provider: b.Name, Capability: CapDeleteWorkout}
}

func (b BaseProvider) QuerySchedule(context.Context, string, string, string) ([]ScheduledWorkoutSummary, error) {
	return nil, &FeatureNotSupported{Provider: b.Name, Capability: CapQuerySchedule}
}

func (b BaseProvider) PullWatchSchedule(context.Context, string, string, string) (WatchSchedulePull, error) {
	return WatchSchedulePull{}, &FeatureNotSupported{Provider: b.Name, Capability: CapQuerySchedule}
}

func (b BaseProvider) QueryExercises(context.Context, string, string) ([]map[string]any, error) {
	return nil, &FeatureNotSupported{Provider: b.Name, Capability: CapExerciseCatalog}
}

func (b BaseProvider) AddCustomExercise(context.Context, string, map[string]any) (string, error) {
	return "", &FeatureNotSupported{Provider: b.Name, Capability: CapCustomExercise}
}

// RequireCapability returns *FeatureNotSupported up front if p doesn't declare
// cap — for callers that want to fail fast before doing work.
func RequireCapability(p Provider, cap Capability) error {
	if !p.Info().Capabilities.Has(cap) {
		return &FeatureNotSupported{Provider: p.Info().Name, Capability: cap}
	}
	return nil
}
