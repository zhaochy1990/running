// sync.go is the COROS adapter: it implements provider.Provider and orchestrates
// a sync (incremental activity scan → detail fetch → normalize → store, plus
// daily health). SyncUser owns the whole run and writes via storage.Writer
// (DI), so the same core backs both the CLI and a future worker job handler.
package coros

import (
	"context"
	"encoding/json"
	"fmt"
	"sync"
	"time"

	"go.uber.org/zap"

	"github.com/zhaochy1990/stride/internal/logging"
	"github.com/zhaochy1990/stride/internal/provider"
	"github.com/zhaochy1990/stride/internal/storage"
)

const providerName = "coros"

// Provider is the COROS watch-data adapter.
type Provider struct {
	provider.BaseProvider
	store     storage.Writer
	creds     CredentialStore
	delay     time.Duration
	baselines BaselineLoader

	// newClient builds the HTTP client for an account; overridable in tests.
	newClient func(c Credentials, save CredentialSaver) *Client
}

// New builds a COROS provider. store persists watch data; creds loads/saves
// login credentials.
func New(store storage.Writer, creds CredentialStore, opts ...ProviderOption) *Provider {
	p := &Provider{
		BaseProvider: provider.BaseProvider{Name: providerName},
		store:        store,
		creds:        creds,
		delay:        500 * time.Millisecond,
	}
	p.newClient = func(c Credentials, save CredentialSaver) *Client {
		return NewClient(c, WithRequestDelay(p.delay), WithCredentialSaver(save))
	}
	for _, o := range opts {
		o(p)
	}
	return p
}

// ProviderOption configures a Provider.
type ProviderOption func(*Provider)

// BaselineLoader supplies the athlete calibration baselines used to resolve
// relative/zone workout targets at push time. It is wired from the calibration
// domain by the composition root so the adapter stays free of storage reads of
// its own. A nil loader (or zero baselines) means "no calibration": relative
// targets then fail loudly at resolution, and an absolute pace target is pushed
// without a fabricated intensityPercent.
type BaselineLoader func(ctx context.Context, user string) (provider.Baselines, error)

// WithBaselineLoader wires the calibration-baseline loader for push-time target
// resolution.
func WithBaselineLoader(l BaselineLoader) ProviderOption {
	return func(p *Provider) { p.baselines = l }
}

// loadBaselines returns the athlete baselines, or zero baselines when no loader
// is wired.
func (p *Provider) loadBaselines(ctx context.Context, user string) (provider.Baselines, error) {
	if p.baselines == nil {
		return provider.Baselines{}, nil
	}
	return p.baselines(ctx, user)
}

// WithClientFactory overrides how the HTTP client is built (used by tests to
// inject an httptest-backed client).
func WithClientFactory(f func(c Credentials, save CredentialSaver) *Client) ProviderOption {
	return func(p *Provider) { p.newClient = f }
}

// WithProviderRequestDelay sets the default per-request base spacing that seeds
// the client's shared rate limiter (aggregate ceiling = jobs/delay).
func WithProviderRequestDelay(d time.Duration) ProviderOption {
	return func(p *Provider) { p.delay = d }
}

// Info declares the COROS provider capabilities. v2 adds run + strength
// workout push, delete, schedule query, and the exercise catalog (mirroring
// coros_sync.adapter._COROS_INFO + the methods implemented in workout_push.go).
func (p *Provider) Info() provider.ProviderInfo {
	return provider.ProviderInfo{
		Name:        providerName,
		DisplayName: "高驰",
		Regions:     []string{"global", "cn", "eu"},
		Capabilities: provider.Capabilities{
			provider.CapSyncHRVDetail:       true,
			provider.CapPushRunWorkout:      true,
			provider.CapPushStrengthWorkout: true,
			provider.CapDeleteWorkout:       true,
			provider.CapQuerySchedule:       true,
			provider.CapExerciseCatalog:     true,
			provider.CapCustomExercise:      true,
		},
	}
}

// IsLoggedIn reports whether stored credentials carry an access token.
func (p *Provider) IsLoggedIn(user string) (bool, error) {
	c, err := p.creds.Load(context.Background(), user)
	if err != nil {
		return false, err
	}
	return c.AccessToken != "", nil
}

// Login authenticates and persists credentials for user.
func (p *Provider) Login(ctx context.Context, user string, in provider.LoginCredentials) (provider.LoginResult, error) {
	client := p.newClient(Credentials{}, p.saver(user))
	c, err := client.Login(ctx, in.Email, in.Password)
	if err != nil {
		return provider.LoginResult{Success: false, Message: err.Error()}, err
	}
	return provider.LoginResult{Success: true, UserID: c.UserID, Region: c.Region}, nil
}

// saver returns a CredentialSaver that persists to the credential store for user.
func (p *Provider) saver(user string) CredentialSaver {
	return func(c Credentials) error { return p.creds.Save(context.Background(), user, c) }
}

// clientFor loads credentials and builds an authenticated client for user.
func (p *Provider) clientFor(ctx context.Context, user string) (*Client, error) {
	c, err := p.creds.Load(ctx, user)
	if err != nil {
		return nil, err
	}
	if c.AccessToken == "" {
		return nil, provider.ErrAuthRequired
	}
	return p.newClient(c, p.saver(user)), nil
}

// SyncUser runs a sync for user and returns a summary. Mode governs the activity
// scan; health always refreshes its window. A zero Content means ContentAll.
func (p *Provider) SyncUser(ctx context.Context, user string, opts provider.SyncOptions) (provider.SyncResult, error) {
	content := opts.Content
	if content == 0 {
		content = provider.ContentAll
	}
	client, err := p.clientFor(ctx, user)
	if err != nil {
		return provider.SyncResult{}, err
	}
	// Install the shared rate limiter sized for this run's concurrency before
	// any fetch worker starts, so every read request (activities + health)
	// shares one aggregate ceiling to COROS.
	client.EnableRateLimit(provider.DetailJobs(opts.Jobs))

	var res provider.SyncResult
	if content.Has(provider.ContentActivities) {
		if err := p.syncActivities(ctx, client, user, opts, &res); err != nil {
			return res, err
		}
	}
	if content.Has(provider.ContentHealth) {
		if err := p.syncHealth(ctx, client, user, opts.Progress, &res); err != nil {
			return res, err
		}
	}
	if content.Has(provider.ContentSchedule) {
		if err := p.syncSchedule(ctx, client, user, &res); err != nil {
			return res, err
		}
	}
	return res, nil
}

// listItem is one entry of the /activity/query dataList. Date is flexible
// because COROS reports it as a number (YYYYMMDD) in real payloads.
type listItem struct {
	LabelID   string     `json:"labelId"`
	SportType int        `json:"sportType"`
	SportName string     `json:"sportName"`
	Date      flexString `json:"date"`
}

// syncActivities collects the activity list (paging, stopping at the first
// already-synced activity in incremental mode), then fetches + upserts each
// activity's detail. It emits per-activity progress so a long full sync is
// legible on the job row.
//
// Detail fetch is parallel (opts.Jobs workers, clamped by clampJobs) but the
// store commits stay strictly ordered oldest-first — see fetchDetailsOrdered
// for why that preserves the incremental-scan cursor invariant.
func (p *Provider) syncActivities(ctx context.Context, client *Client, user string, opts provider.SyncOptions, res *provider.SyncResult) error {
	items, err := p.collectActivities(ctx, client, user, opts)
	if err != nil {
		return err
	}
	total := len(items)
	provider.EmitProgress(opts.Progress, "activities", 0, total, provider.PercentInBand(0, total, 10, 80))
	if total == 0 {
		return nil
	}

	// collectActivities returns items newest-first (COROS pages descend by
	// date). Reverse to oldest-first so the ordered commit persists a
	// contiguous oldest-first prefix on a partial run.
	ordered := make([]listItem, total)
	for i, item := range items {
		ordered[total-1-i] = item
	}
	_, err = p.fetchDetailsOrdered(ctx, client, user, ordered, provider.DetailJobs(opts.Jobs), opts.Progress, res, nil)
	return err
}

// collectActivities pages the activity list and returns the items to sync,
// stopping at the first already-synced activity in incremental mode and honoring
// opts.Limit. Full mode collects known activities too (re-scan) and therefore
// skips the per-item ActivityExists probe entirely — in full mode its result
// never changes the outcome (every item is appended), so issuing the COUNT would
// be a wasted round-trip per activity.
func (p *Provider) collectActivities(ctx context.Context, client *Client, user string, opts provider.SyncOptions) ([]listItem, error) {
	const pageSize = 20
	full := opts.Mode == provider.SyncFull
	var items []listItem
	for page := 1; ; page++ {
		raw, err := client.ListActivities(ctx, page, pageSize)
		if err != nil {
			return nil, err
		}
		var pageData struct {
			DataList []listItem `json:"dataList"`
		}
		if err := json.Unmarshal(raw, &pageData); err != nil {
			return nil, fmt.Errorf("coros: parse activity list: %w", err)
		}
		if len(pageData.DataList) == 0 {
			return items, nil
		}
		for _, item := range pageData.DataList {
			if !isKnownSportCode(item.SportType) {
				logging.Default().Warn("coros: skipping activity with unknown sport type",
					zap.String("label_id", item.LabelID),
					zap.Int("sport_type", item.SportType),
					zap.String("sport_name", item.SportName),
					zap.String("date", string(item.Date)))
				continue
			}
			if !full {
				exists, err := p.store.ActivityExists(ctx, user, item.LabelID)
				if err != nil {
					return nil, err
				}
				if exists {
					return items, nil // incremental catch-up: reached known history
				}
			}
			items = append(items, item)
			if opts.Limit > 0 && len(items) >= opts.Limit {
				return items, nil // bounded run
			}
		}
		if len(pageData.DataList) < pageSize {
			return items, nil // last page
		}
	}
}

// detailResult carries one activity's parsed detail (or the fetch/parse error)
// from a fetch worker to the ordered committer.
type detailResult struct {
	a     *storage.Activity
	laps  []storage.Lap
	ts    []storage.TimeseriesPoint
	zones []storage.ActivityWatchZone
	err   error
}

// fetchDetailsOrdered fetches each activity's detail concurrently (bounded by
// jobs) while committing to the store strictly in the given order — callers
// choose the order (the incremental path passes oldest-first; the onboarding
// range path passes newest-first since 11-17 so recent activities land first).
// Commit halts at the first fetch, parse, or store error, so the persisted
// set is always a contiguous prefix of the input order. For the incremental
// caller that is what keeps its cursor safe: a later incremental scan walks
// newest-first and stops at the first activity that already exists, so every
// not-yet-persisted (newer) activity is re-fetched — no holes. The range
// caller never relies on that stop rule: it full-window rescans on retry and
// RecentGapCheck covers partial runs while the session is incomplete.
//
// skip, when non-nil, is offered every fetch error that is a PERMANENT
// provider rejection (provider.IsInvalidRequest): returning normally records
// the item as skipped-and-continued instead of halting the commit (the
// onboarding range path turns it into a gap). A nil skip, or a non-permanent
// error, halts as before. The committed activity rows are returned so callers
// that derive coverage from actual data (not from intent) can.
//
// A feeder hands indices out in order, so workers pull roughly sequentially and
// at most ~jobs fetched-but-uncommitted results are held in memory at once.
func (p *Provider) fetchDetailsOrdered(
	ctx context.Context,
	client *Client,
	user string,
	ordered []listItem,
	jobs int,
	progress provider.ProgressCallback,
	res *provider.SyncResult,
	skip func(item listItem, err error),
) ([]*storage.Activity, error) {
	total := len(ordered)
	results := make([]detailResult, total)
	ready := make([]chan struct{}, total)
	for i := range ready {
		ready[i] = make(chan struct{})
	}

	// fetchCtx cancels in-flight and pending fetches once the committer stops
	// (error or ctx cancellation), so workers unwind promptly.
	fetchCtx, cancelFetch := context.WithCancel(ctx)
	defer cancelFetch()

	indexCh := make(chan int)
	go func() {
		defer close(indexCh)
		for i := 0; i < total; i++ {
			select {
			case indexCh <- i:
			case <-fetchCtx.Done():
				return
			}
		}
	}()

	var wg sync.WaitGroup
	for w := 0; w < jobs; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := range indexCh {
				a, laps, ts, zones, err := p.fetchOneDetail(fetchCtx, client, ordered[i], user)
				results[i] = detailResult{a: a, laps: laps, ts: ts, zones: zones, err: err}
				close(ready[i])
			}
		}()
	}

	// Commit in order. Store writes use the caller ctx (not fetchCtx) so an
	// in-progress upsert is not cancelled by our own fetch-teardown.
	var commitErr error
	var committed []*storage.Activity
	for i := 0; i < total; i++ {
		select {
		case <-ready[i]:
		case <-ctx.Done():
			commitErr = ctx.Err()
		}
		if commitErr != nil {
			break
		}
		r := results[i]
		results[i] = detailResult{}
		if r.err != nil {
			if skip != nil && isRangeRejection(r.err) {
				skip(ordered[i], r.err)
				continue // permanently rejected: gap and keep committing
			}
			commitErr = r.err
			break
		}
		if err := p.store.UpsertActivity(ctx, r.a, r.laps, r.ts, r.zones); err != nil {
			commitErr = err
			break
		}
		committed = append(committed, r.a)
		res.Activities++
		res.ActivityLabelIDs = append(res.ActivityLabelIDs, ordered[i].LabelID)
		if err := p.store.SetMeta(ctx, user, "last_label_id", ordered[i].LabelID); err != nil {
			commitErr = err
			break
		}
		provider.EmitProgress(progress, "activities", i+1, total, provider.PercentInBand(i+1, total, 10, 80))
	}

	cancelFetch()
	wg.Wait()
	if commitErr != nil && skip != nil {
		for i, result := range results {
			if isRangeRejection(result.err) {
				skip(ordered[i], result.err)
			}
		}
	}
	return committed, commitErr
}

// fetchOneDetail fetches and parses a single activity's detail. It performs no
// store writes, so it is safe to run concurrently across workers.
func (p *Provider) fetchOneDetail(ctx context.Context, client *Client, item listItem, user string) (
	*storage.Activity, []storage.Lap, []storage.TimeseriesPoint, []storage.ActivityWatchZone, error,
) {
	raw, err := client.GetActivityDetail(ctx, item.LabelID, item.SportType)
	if err != nil {
		return nil, nil, nil, nil, err
	}
	return ParseActivityDetail(user, item.LabelID, parseListDate(string(item.Date)), raw)
}

// dayItem is one entry of the /analyse/query dayList.
type dayItem struct {
	HappenDay         json.Number `json:"happenDay"`
	Date              string      `json:"date"`
	ATI               *float64    `json:"ati"`
	CTI               *float64    `json:"cti"`
	TestRhr           *int        `json:"testRhr"`
	Rhr               *int        `json:"rhr"`
	Distance          *float64    `json:"distance"`
	Duration          *float64    `json:"duration"`
	TrainingLoadRatio *float64    `json:"trainingLoadRatio"`
	TiredRate         *float64    `json:"tiredRate"`
	Fatigue           *float64    `json:"fatigue"`
}

// analyseDayDate resolves one analyse dayList entry's date label to the ISO
// YYYY-MM-DD every downstream contract shares (daily_health's date primary
// key, the range channel's coverage labels, ordering and gap arithmetic): the
// vendor's date string when present, else the happenDay number, which arrives
// compact (YYYYMMDD) and is normalized through corosDateToISO — an already-ISO
// label passes through untouched. ok=false skips a row with neither field
// usable (devops#1008 D1: a compact label leaking into the coverage chain
// breaks string ordering and inverts gap ranges).
func analyseDayDate(d dayItem) (string, bool) {
	date := d.Date
	if date == "" {
		date = d.HappenDay.String()
	}
	if date == "" {
		return "", false
	}
	return corosDateToISO(date), true
}

// syncHealth refreshes daily_health from /analyse/query, then the dashboard
// singleton, per-day HRV trend, and race predictions from /dashboard/query
// (+ /dashboard/detail/query for the weekly volume).
func (p *Provider) syncHealth(ctx context.Context, client *Client, user string, progress provider.ProgressCallback, res *provider.SyncResult) error {
	raw, err := client.GetAnalyse(ctx)
	if err != nil {
		return err
	}
	var data struct {
		DayList []dayItem `json:"dayList"`
	}
	if err := json.Unmarshal(raw, &data); err != nil {
		return fmt.Errorf("coros: parse analyse: %w", err)
	}
	total := len(data.DayList)
	for i, d := range data.DayList {
		date, ok := analyseDayDate(d)
		if !ok {
			continue
		}
		if err := p.store.UpsertDailyHealth(ctx, dayItemToHealth(user, d, date)); err != nil {
			return err
		}
		res.Health++
		res.HealthDates = append(res.HealthDates, date)
		provider.EmitProgress(progress, "health", i+1, total, provider.PercentInBand(i+1, total, 80, 90))
	}
	return p.syncDashboard(ctx, client, user, progress, res)
}

// fetchDashboardPayloads pulls the dashboard summary and the optional weekly-
// volume record. A summary failure is an error; a week-record failure is logged
// and yields a nil week (the dashboard row is still usable — the missing weekly
// volume stays traceable in logs).
func (p *Provider) fetchDashboardPayloads(ctx context.Context, client *Client, user string) (summary, week json.RawMessage, err error) {
	summary, err = client.GetDashboard(ctx)
	if err != nil {
		return nil, nil, err
	}
	week, werr := client.GetDashboardDetail(ctx)
	if werr != nil {
		logging.Default().Warn("coros: fetch dashboard detail failed; weekly volume will be absent",
			zap.String("user", user), zap.Error(werr))
		week = nil
	}
	return summary, week, nil
}

// storeDashboard parses the dashboard payloads and writes the singleton, the
// per-day HRV rows, and the race predictions. res.Health counts the writes (1
// singleton + per HRV row) for both the periodic sync and the onboarding range
// dashboard channel.
func (p *Provider) storeDashboard(ctx context.Context, user string, summaryData, weekData json.RawMessage, progress provider.ProgressCallback, res *provider.SyncResult) error {
	dash, hrvRows, preds := parseDashboard(user, summaryData, weekData)
	if dash != nil {
		var err error
		if dash.AvgSleepHRV == nil || dash.HRVNormalLow == nil || dash.HRVNormalHigh == nil {
			err = p.store.UpsertDashboardPreservingNil(ctx, dash)
		} else {
			err = p.store.UpsertDashboard(ctx, dash)
		}
		if err != nil {
			return err
		}
		res.Health++
	}
	for _, h := range hrvRows {
		if err := p.store.UpsertDailyHRV(ctx, h); err != nil {
			return err
		}
		res.Health++
		res.HealthDates = append(res.HealthDates, h.Date)
	}
	for i := range preds {
		if err := p.store.UpsertRacePrediction(ctx, &preds[i]); err != nil {
			return err
		}
	}
	provider.EmitProgress(progress, "health", 1, 1, 95)
	return nil
}

// syncDashboard is the periodic sync's best-effort dashboard pass: a fetch
// failure must not abort an otherwise-successful daily_health sync (matching
// the Python narrowed try/except), so it is logged (WARN) and swallowed. The
// onboarding range channel does NOT use this — its work item must fail loudly
// (rangeDashboard calls fetchDashboardPayloads directly).
func (p *Provider) syncDashboard(ctx context.Context, client *Client, user string, progress provider.ProgressCallback, res *provider.SyncResult) error {
	summaryData, weekData, err := p.fetchDashboardPayloads(ctx, client, user)
	if err != nil {
		logging.Default().Warn("coros: fetch dashboard failed; skipping dashboard/daily_hrv/race_predictions",
			zap.String("user", user), zap.Error(err))
		return nil
	}
	return p.storeDashboard(ctx, user, summaryData, weekData, progress, res)
}

// ResyncActivity re-fetches and upserts a single activity by label.
func (p *Provider) ResyncActivity(ctx context.Context, user, labelID string) (bool, error) {
	client, err := p.clientFor(ctx, user)
	if err != nil {
		return false, err
	}
	// sportType is unknown here; 0 is accepted by the detail endpoint (it keys on
	// labelId). The parser reads the real sportType from the returned summary.
	raw, err := client.GetActivityDetail(ctx, labelID, 0)
	if err != nil {
		return false, err
	}
	a, laps, ts, zones, err := ParseActivityDetail(user, labelID, time.Time{}, raw)
	if err != nil {
		return false, err
	}
	if err := p.store.UpsertActivity(ctx, a, laps, ts, zones); err != nil {
		return false, err
	}
	return true, nil
}

var _ provider.Provider = (*Provider)(nil)

// ─────────────────────────────────────────────────────────────────────────────
// helpers
// ─────────────────────────────────────────────────────────────────────────────

// parseListDate best-effort parses the list endpoint's date string into a UTC
// time, used only as a fallback when a detail lacks a startTimestamp.
func parseListDate(s string) time.Time {
	for _, layout := range []string{time.RFC3339, "2006-01-02 15:04:05", "2006-01-02", "20060102"} {
		if t, err := time.Parse(layout, s); err == nil {
			return t.UTC()
		}
	}
	return time.Time{}
}

func firstInt(a, b *int) *int {
	if a != nil {
		return a
	}
	return b
}

func firstFloat(a, b *float64) *float64 {
	if a != nil {
		return a
	}
	return b
}
