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
	"errors"
	"fmt"
)

// ─────────────────────────────────────────────────────────────────────────────
// Sync progress + result
// ─────────────────────────────────────────────────────────────────────────────

// SyncProgress is a free-form progress event emitted during a sync run.
type SyncProgress = map[string]any

// ProgressCallback receives incremental progress events. It may be nil.
type ProgressCallback func(SyncProgress)

// SyncMode is the DEPTH axis of a sync: how far back the activity scan goes.
type SyncMode string

const (
	// SyncIncremental stops the activity scan at the first already-synced
	// activity (fast catch-up). It is the default.
	SyncIncremental SyncMode = "incremental"
	// SyncFull re-scans the entire activity history and re-fetches details.
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
	// ContentAll is every domain.
	ContentAll = ContentActivities | ContentHealth
)

// Has reports whether c includes domain d.
func (c SyncContent) Has(d SyncContent) bool { return c&d != 0 }

// SyncOptions controls a sync run. Mode governs the activity scan only; health
// always syncs by date window. A zero Content is treated as ContentAll by
// SyncUser implementations. Limit caps the number of activities fetched (0 =
// unlimited) — useful for bounded validation runs.
type SyncOptions struct {
	Mode     SyncMode
	Content  SyncContent
	Limit    int
	Progress ProgressCallback
}

// SyncResult summarizes a sync run.
type SyncResult struct {
	Activities       int      // activities written/updated
	Health           int      // health-domain writes (daily_health + HRV + dashboard); display count
	ActivityLabelIDs []string // label_ids touched this run
	HealthDates      []string // Shanghai calendar dates whose daily_health rows were refreshed
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

// ─────────────────────────────────────────────────────────────────────────────
// Workout specs (placeholders; the real port lands with push support)
// ─────────────────────────────────────────────────────────────────────────────

// RunWorkout is a placeholder so the full Provider contract compiles. The
// complete port of stride_core.workout_spec.NormalizedRunWorkout is deferred
// until run-workout push is implemented.
type RunWorkout struct{}

// StrengthWorkout is a placeholder; see RunWorkout.
type StrengthWorkout struct{}

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

	// exercise catalog (optional, capability-gated)
	QueryExercises(ctx context.Context, user, sport string) ([]map[string]any, error)
	AddCustomExercise(ctx context.Context, user string, exercise map[string]any) (string, error)
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
