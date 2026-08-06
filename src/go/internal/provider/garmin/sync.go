// sync.go is the Garmin adapter: it implements provider.Provider and orchestrates
// a sync (incremental activity scan → detail/splits/weather → normalize → store,
// plus a daily-health window and the dashboard singleton). SyncUser writes via
// storage.Writer (DI) so the same core backs both the CLI and a future worker job.
//
// Go port of garmin_sync.sync. Full write-set parity with the Python path, in
// shadow mode (ADR 0005/0009).
package garmin

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"time"

	"go.uber.org/zap"

	"github.com/zhaochy1990/stride/internal/logging"
	"github.com/zhaochy1990/stride/internal/provider"
	"github.com/zhaochy1990/stride/internal/storage"
	"github.com/zhaochy1990/stride/internal/utils/timefmt"
)

const providerName = "garmin"

const (
	activityDetailsMaxChart = 20_000
	activityDetailsMaxPoly  = 20_000
	// healthWindowDays is the incremental (default) daily-health lookback: a
	// short catch-up window for routine syncs.
	healthWindowDays = 28
	// healthWindowDaysFull is the SyncFull daily-health lookback. A full sync is
	// the DEPTH axis for health too (matching the activity scan): it walks back
	// a year so onboarding/full rebuilds seed the downstream compute windows
	// (training load 365d, RHR baseline 90d, calibration 180d — all ≤ 365).
	// The consecutive-empty cutoff still terminates early for shorter histories.
	healthWindowDaysFull = 365
	healthMaxConsecEmpty = 7
)

// Provider is the Garmin watch-data adapter.
type Provider struct {
	provider.BaseProvider
	store storage.Writer
	creds CredentialStore
	delay time.Duration

	// newClient builds the HTTP client for an account; overridable in tests.
	newClient func(c Credentials, save CredentialSaver) *Client
}

// New builds a Garmin provider. store persists watch data; creds loads/saves
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

// WithClientFactory overrides how the HTTP client is built (tests inject an
// httptest-backed client).
func WithClientFactory(f func(c Credentials, save CredentialSaver) *Client) ProviderOption {
	return func(p *Provider) { p.newClient = f }
}

// WithProviderRequestDelay sets the default per-request rate-limit pause.
func WithProviderRequestDelay(d time.Duration) ProviderOption {
	return func(p *Provider) { p.delay = d }
}

// Info declares the Garmin provider capabilities: HRV detail, sleep, and body
// battery (the Garmin-native signals COROS lacks). Push/exercise stay unsupported.
func (p *Provider) Info() provider.ProviderInfo {
	return provider.ProviderInfo{
		Name:        providerName,
		DisplayName: "佳明",
		Regions:     []string{"global", "cn"},
		Capabilities: provider.Capabilities{
			provider.CapSyncHRVDetail:   true,
			provider.CapSyncSleep:       true,
			provider.CapSyncBodyBattery: true,
		},
	}
}

// IsLoggedIn reports whether stored credentials carry a usable OAuth1 token.
func (p *Provider) IsLoggedIn(user string) (bool, error) {
	c, err := p.creds.Load(context.Background(), user)
	if err != nil {
		return false, err
	}
	return c.LoggedIn(), nil
}

// Login authenticates and persists credentials for user. Region comes from the
// login payload (default "cn" — the primary market); it selects garmin.cn vs
// garmin.com. Fails with ErrMFARequired if the account has 2FA enabled (v1).
func (p *Provider) Login(ctx context.Context, user string, in provider.LoginCredentials) (provider.LoginResult, error) {
	region := in.Region
	if region == "" {
		region = "cn"
	}
	client := p.newClient(Credentials{Region: region}, p.saver(user))
	c, err := client.Login(ctx, in.Email, in.Password)
	if err != nil {
		return provider.LoginResult{Success: false, Message: err.Error()}, err
	}
	return provider.LoginResult{Success: true, UserID: c.UserName, Region: c.Region}, nil
}

// saver returns a CredentialSaver that persists to the credential store for user.
func (p *Provider) saver(user string) CredentialSaver {
	return func(c Credentials) error { return p.creds.Save(context.Background(), user, c) }
}

// clientFor loads credentials, builds an authenticated client, and loads the
// profile (needed by the user-summary / sleep / race endpoints).
func (p *Provider) clientFor(ctx context.Context, user string) (*Client, error) {
	c, err := p.creds.Load(ctx, user)
	if err != nil {
		return nil, err
	}
	if !c.LoggedIn() {
		return nil, provider.ErrAuthRequired
	}
	client := p.newClient(c, p.saver(user))
	if err := client.ensureProfile(ctx); err != nil {
		return nil, err
	}
	return client, nil
}

// SyncUser runs a sync for user and returns a summary. Mode is the depth axis
// for both domains: it governs how far back the activity scan and the daily-
// health window reach. A zero Content means ContentAll.
func (p *Provider) SyncUser(ctx context.Context, user string, opts provider.SyncOptions) (provider.SyncResult, error) {
	started := time.Now()
	jobs := provider.DetailJobs(opts.Jobs)
	log := logging.Default().With(
		zap.String("provider", providerName),
		zap.String("user", user),
		zap.String("mode", string(opts.Mode)),
		zap.Int("jobs", jobs),
	)
	content := opts.Content
	if content == 0 {
		content = provider.ContentAll
	}
	client, err := p.clientFor(ctx, user)
	if err != nil {
		log.Warn("watch sync client initialization failed", append(syncErrorFields(err), zap.Duration("elapsed", time.Since(started)))...)
		return provider.SyncResult{}, err
	}
	client.EnableRateLimit(jobs)

	var res provider.SyncResult
	if content.Has(provider.ContentActivities) {
		phaseStarted := time.Now()
		if err := p.syncActivities(ctx, client, user, opts, &res); err != nil {
			log.Warn("watch sync activities failed", append(syncErrorFields(err), zap.Duration("elapsed", time.Since(phaseStarted)))...)
			return res, err
		}
		log.Info("watch sync activities completed", zap.Int("activities", res.Activities), zap.Duration("elapsed", time.Since(phaseStarted)))
	}
	if content.Has(provider.ContentHealth) {
		phaseStarted := time.Now()
		if err := p.syncHealth(ctx, client, user, opts, &res); err != nil {
			log.Warn("watch sync health failed", append(syncErrorFields(err), zap.Duration("elapsed", time.Since(phaseStarted)))...)
			return res, err
		}
		log.Info("watch sync health completed", zap.Int("writes", res.Health), zap.Duration("elapsed", time.Since(phaseStarted)))
	}
	log.Info("watch sync completed", zap.Int("activities", res.Activities), zap.Int("health_writes", res.Health), zap.Duration("elapsed", time.Since(started)))
	return res, nil
}

func syncErrorFields(err error) []zap.Field {
	fields := []zap.Field{zap.String("error_type", fmt.Sprintf("%T", err))}
	var apiErr *APIError
	if errors.As(err, &apiErr) {
		fields = append(fields, zap.Int("http_status", apiErr.Status))
	}
	return fields
}

// syncActivities collects the activity list (paging, stopping at the first
// already-synced activity in incremental mode), then fetches + upserts each
// activity's detail, emitting per-activity progress like the COROS adapter.
func (p *Provider) syncActivities(ctx context.Context, client *Client, user string, opts provider.SyncOptions, res *provider.SyncResult) error {
	scanStarted := time.Now()
	items, err := p.collectActivities(ctx, client, user, opts)
	if err != nil {
		return err
	}
	total := len(items)
	logging.Default().Info("garmin activity scan completed",
		zap.String("user", user), zap.Int("activities", total), zap.Duration("elapsed", time.Since(scanStarted)))
	provider.EmitProgress(opts.Progress, "activities", 0, total, provider.PercentInBand(0, total, 10, 80))
	if total == 0 {
		return nil
	}
	ordered := make([]rawActivity, total)
	for i, item := range items {
		ordered[total-1-i] = item
	}
	jobs := provider.DetailJobs(opts.Jobs)
	return p.fetchActivitiesOrdered(ctx, client, user, ordered, jobs, opts.Progress, res)
}

// collectActivities pages the activity list and returns the items to sync,
// stopping at the first already-synced activity in incremental mode and honoring
// opts.Limit. Full mode collects known activities too (re-scan).
func (p *Provider) collectActivities(ctx context.Context, client *Client, user string, opts provider.SyncOptions) ([]rawActivity, error) {
	const pageSize = 20
	full := opts.Mode == provider.SyncFull
	var items []rawActivity
	for start := 0; ; {
		raw, err := client.ListActivities(ctx, start, pageSize)
		if err != nil {
			return nil, err
		}
		acts, err := parseActivityList(raw)
		if err != nil {
			return nil, err
		}
		if len(acts) == 0 {
			return items, nil
		}
		for _, a := range acts {
			labelID := a.labelID()
			if labelID == "" {
				continue
			}
			if !full {
				exists, err := p.store.ActivityExists(ctx, user, labelID)
				if err != nil {
					return nil, err
				}
				if exists {
					return items, nil // incremental catch-up: reached known history
				}
			}
			items = append(items, a)
			if opts.Limit > 0 && len(items) >= opts.Limit {
				return items, nil // bounded run
			}
		}
		start += len(acts)
		if len(acts) < pageSize {
			return items, nil // last page
		}
	}
}

type activityResult struct {
	activity   *storage.Activity
	laps       []storage.Lap
	timeseries []storage.TimeseriesPoint
	fetchTime  time.Duration
	err        error
}

func (p *Provider) fetchActivitiesOrdered(ctx context.Context, client *Client, user string, ordered []rawActivity, jobs int, progress provider.ProgressCallback, res *provider.SyncResult) error {
	started := time.Now()
	var fetchTotal, fetchMax, commitTotal, commitMax time.Duration
	var lapsTotal, timeseriesTotal int
	results := make([]activityResult, len(ordered))
	ready := make([]chan struct{}, len(ordered))
	for i := range ready {
		ready[i] = make(chan struct{})
	}
	fetchCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	indices := make(chan int)
	inFlight := make(chan struct{}, jobs)
	go func() {
		defer close(indices)
		for i := range ordered {
			select {
			case inFlight <- struct{}{}:
			case <-fetchCtx.Done():
				return
			}
			select {
			case indices <- i:
			case <-fetchCtx.Done():
				return
			}
		}
	}()
	var wg sync.WaitGroup
	for range jobs {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := range indices {
				results[i] = p.fetchOneActivity(fetchCtx, client, user, ordered[i])
				close(ready[i])
			}
		}()
	}
	var commitErr error
	for i := range ordered {
		select {
		case <-ready[i]:
		case <-ctx.Done():
			commitErr = ctx.Err()
		}
		if commitErr != nil {
			break
		}
		r := results[i]
		results[i] = activityResult{}
		<-inFlight
		fetchTotal += r.fetchTime
		fetchMax = max(fetchMax, r.fetchTime)
		if r.err != nil {
			commitErr = r.err
			break
		}
		commitStarted := time.Now()
		if err := p.store.UpsertActivityPreservingEmptyChildren(ctx, r.activity, r.laps, r.timeseries, nil); err != nil {
			commitErr = err
			break
		}
		labelID := ordered[i].labelID()
		lapsTotal += len(r.laps)
		timeseriesTotal += len(r.timeseries)
		res.Activities++
		res.ActivityLabelIDs = append(res.ActivityLabelIDs, labelID)
		if err := p.store.SetMeta(ctx, user, "last_label_id", labelID); err != nil {
			commitErr = err
			break
		}
		commitTime := time.Since(commitStarted)
		commitTotal += commitTime
		commitMax = max(commitMax, commitTime)
		provider.EmitProgress(progress, "activities", i+1, len(ordered), provider.PercentInBand(i+1, len(ordered), 10, 80))
	}
	cancel()
	wg.Wait()
	logActivityPipeline(user, jobs, res.Activities, lapsTotal, timeseriesTotal,
		fetchTotal, fetchMax, commitTotal, commitMax, time.Since(started), commitErr)
	return commitErr
}

func logActivityPipeline(user string, jobs, activities, laps, timeseries int, fetchTotal, fetchMax, commitTotal, commitMax, elapsed time.Duration, err error) {
	log := logging.Default().Info
	message := "garmin activity detail pipeline completed"
	if err != nil {
		log = logging.Default().Warn
		message = "garmin activity detail pipeline failed"
	}
	log(message,
		zap.String("user", user), zap.Int("activities", activities), zap.Int("laps", laps),
		zap.Int("timeseries", timeseries), zap.Int("jobs", jobs),
		zap.Duration("fetch_total", fetchTotal), zap.Duration("fetch_max", fetchMax),
		zap.Duration("commit_total", commitTotal), zap.Duration("commit_max", commitMax),
		zap.Duration("elapsed", elapsed), zap.Bool("failed", err != nil))
}

func (p *Provider) fetchOneActivity(ctx context.Context, client *Client, user string, a rawActivity) (result activityResult) {
	started := time.Now()
	defer func() { result.fetchTime = time.Since(started) }()
	labelID := a.labelID()
	detailsRaw, err := client.GetActivityDetails(ctx, labelID, activityDetailsMaxChart, activityDetailsMaxPoly)
	if err != nil {
		if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
			result.err = err
			return result
		}
		detailsRaw = nil
	}
	splitsRaw, err := client.GetActivitySplits(ctx, labelID)
	if err != nil {
		if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
			result.err = err
			return result
		}
		splitsRaw = nil
	}
	var detailShape map[string]json.RawMessage
	var splitShape map[string]json.RawMessage
	if json.Unmarshal(detailsRaw, &detailShape) != nil || detailShape["activityDetailMetrics"] == nil {
		detailsRaw = nil
	}
	if json.Unmarshal(splitsRaw, &splitShape) != nil || splitShape["lapDTOs"] == nil {
		splitsRaw = nil
	}
	weatherRaw, _ := client.GetActivityWeather(ctx, labelID)
	var weather *rawWeather
	if len(weatherRaw) > 0 {
		var w rawWeather
		if json.Unmarshal(weatherRaw, &w) == nil {
			weather = &w
		}
	}
	result = activityResult{
		activity:   buildActivity(user, a, weather),
		laps:       parseSplits(splitsRaw),
		timeseries: parseDetailsTimeseries(detailsRaw),
	}
	return result
}

// syncOneActivity fetches the detail sub-resources for one activity and upserts
// it. Detail and splits are required because an empty replacement would erase
// existing children; weather remains best-effort.
func (p *Provider) syncOneActivity(ctx context.Context, client *Client, user string, a rawActivity, res *provider.SyncResult) error {
	r := p.fetchOneActivity(ctx, client, user, a)
	if r.err != nil {
		return r.err
	}
	if err := p.store.UpsertActivityPreservingEmptyChildren(ctx, r.activity, r.laps, r.timeseries, nil); err != nil {
		return err
	}
	labelID := a.labelID()
	res.Activities++
	res.ActivityLabelIDs = append(res.ActivityLabelIDs, labelID)
	if err := p.store.SetMeta(ctx, user, "last_label_id", labelID); err != nil {
		return err
	}
	return nil
}

// syncHealth refreshes the daily-health window (daily_health + daily_hrv) and the
// dashboard singleton. Walks most-recent → oldest, bailing after a week of
// consecutive empty days to avoid burning calls on idle accounts. The window
// depth follows opts.Mode: SyncFull reaches back healthWindowDaysFull, otherwise
// the shorter healthWindowDays incremental window.
func (p *Provider) syncHealth(ctx context.Context, client *Client, user string, opts provider.SyncOptions, res *provider.SyncResult) error {
	windowDays := healthWindowDays
	if opts.Mode == provider.SyncFull {
		windowDays = healthWindowDaysFull
	}
	progress := opts.Progress
	today := time.Now().In(timefmt.Shanghai)
	consecEmpty := 0
	for offset := 0; offset < windowDays; offset++ {
		date := today.AddDate(0, 0, -offset).Format("2006-01-02")
		tsRaw, usRaw, sleepRaw, hrvRaw, err := fetchHealthDay(ctx, client, date, provider.DetailJobs(opts.Jobs))
		if err != nil {
			return err
		}

		wrote := false
		if h := buildDailyHealth(user, date, tsRaw, usRaw, sleepRaw); hasSignal(h) {
			if err := p.store.UpsertDailyHealth(ctx, h); err != nil {
				return err
			}
			res.Health++
			res.HealthDates = append(res.HealthDates, date)
			wrote = true
		}
		if hrvRow := buildDailyHRV(user, date, hrvRaw); hrvHasSignal(hrvRow) {
			if err := p.store.UpsertDailyHRV(ctx, hrvRow); err != nil {
				return err
			}
			res.Health++
			wrote = true
		}
		if wrote {
			consecEmpty = 0
		} else {
			consecEmpty++
			if consecEmpty >= healthMaxConsecEmpty {
				break
			}
		}
		provider.EmitProgress(progress, "health", offset+1, windowDays, provider.PercentInBand(offset+1, windowDays, 80, 95))
	}
	return p.syncDashboard(ctx, client, user, today, res)
}

// fetchHealthDay overlaps the four independent Garmin endpoints for one date.
// Dates remain sequential so the seven-empty-days cutoff does not speculatively
// fetch or write older history.
func fetchHealthDay(ctx context.Context, client *Client, date string, jobs int) (tsRaw, usRaw, sleepRaw, hrvRaw json.RawMessage, err error) {
	var tsErr, usErr, sleepErr, hrvErr error
	tasks := []func(){
		func() { tsRaw, tsErr = client.GetTrainingStatus(ctx, date) },
		func() { usRaw, usErr = client.GetUserSummary(ctx, date) },
		func() { sleepRaw, sleepErr = client.GetSleepData(ctx, date) },
		func() { hrvRaw, hrvErr = client.GetHRV(ctx, date) },
	}
	indices := make(chan int)
	var wg sync.WaitGroup
	workers := min(jobs, len(tasks))
	for range workers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := range indices {
				tasks[i]()
			}
		}()
	}
	for i := range tasks {
		indices <- i
	}
	close(indices)
	wg.Wait()
	err = errors.Join(requiredHealthError(tsErr), requiredHealthError(usErr), requiredHealthError(sleepErr), requiredHealthError(hrvErr))
	return
}

func requiredHealthError(err error) error {
	var apiErr *APIError
	if errors.As(err, &apiErr) && apiErr.Status == 404 {
		return nil
	}
	return err
}

// syncDashboard pulls the most-recent metrics into the singleton dashboard row.
func (p *Provider) syncDashboard(ctx context.Context, client *Client, user string, today time.Time, res *provider.SyncResult) error {
	todayISO := today.Format("2006-01-02")
	yesterdayISO := today.AddDate(0, 0, -1).Format("2006-01-02")

	tsRaw, usRaw, _, hrvRaw, err := fetchHealthDay(ctx, client, todayISO, provider.DetailJobs(0))
	if err != nil {
		return err
	}
	// Dashboard uses yesterday's HRV rather than today's daily row.
	hrvRaw, err = client.GetHRV(ctx, yesterdayISO)
	if err = requiredHealthError(err); err != nil {
		return err
	}
	ltRaw, err := client.GetLactateThreshold(ctx)
	if err = requiredHealthError(err); err != nil {
		return err
	}
	rpRaw, err := client.GetRacePredictions(ctx)
	if err = requiredHealthError(err); err != nil {
		return err
	}

	dash, preds := buildDashboard(user, tsRaw, usRaw, hrvRaw, ltRaw, rpRaw)
	if dash.RHR == nil && dash.ThresholdHR == nil && dash.ThresholdPaceSKm == nil && dash.AvgSleepHRV == nil &&
		dash.HRVNormalLow == nil && dash.HRVNormalHigh == nil && len(preds) == 0 {
		return nil
	}
	if dash.RHR != nil || dash.ThresholdHR != nil || dash.ThresholdPaceSKm != nil || dash.AvgSleepHRV != nil ||
		dash.HRVNormalLow != nil || dash.HRVNormalHigh != nil {
		if err := p.store.UpsertDashboardPreservingNil(ctx, dash); err != nil {
			return err
		}
		res.Health++
	}
	for i := range preds {
		if err := p.store.UpsertRacePrediction(ctx, &preds[i]); err != nil {
			return err
		}
	}
	return nil
}

// ResyncActivity re-fetches and upserts a single activity by its Garmin ID. The
// activity summary is re-read from the list endpoint (the detail endpoints key on
// the ID); if not found in the recent list it returns (false, nil).
func (p *Provider) ResyncActivity(ctx context.Context, user, labelID string) (bool, error) {
	client, err := p.clientFor(ctx, user)
	if err != nil {
		return false, err
	}
	client.EnableRateLimit(1)
	// Scan recent activities for a matching id (bounded — resync targets recent).
	for start := 0; start < 200; start += 20 {
		raw, err := client.ListActivities(ctx, start, 20)
		if err != nil {
			return false, err
		}
		acts, err := parseActivityList(raw)
		if err != nil {
			return false, err
		}
		if len(acts) == 0 {
			break
		}
		for _, a := range acts {
			if a.labelID() == labelID {
				var res provider.SyncResult
				if err := p.syncOneActivity(ctx, client, user, a, &res); err != nil {
					return false, err
				}
				return true, nil
			}
		}
		if len(acts) < 20 {
			break
		}
	}
	return false, nil
}

var _ provider.Provider = (*Provider)(nil)
