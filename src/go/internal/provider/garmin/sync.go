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
	"time"

	"github.com/zhaochy1990/stride/internal/provider"
	"github.com/zhaochy1990/stride/internal/storage"
)

const providerName = "garmin"

const (
	activityDetailsMaxChart = 20_000
	activityDetailsMaxPoly  = 20_000
	healthWindowDays        = 28
	healthMaxConsecEmpty    = 7
)

// shanghaiZone is Asia/Shanghai (UTC+8, no DST) — the calendar used to bucket
// daily health, matching stride_core.timefmt on the Python side.
var shanghaiZone = time.FixedZone("CST", 8*3600)

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

	var res provider.SyncResult
	if content.Has(provider.ContentActivities) {
		if err := p.syncActivities(ctx, client, user, opts, &res); err != nil {
			return res, err
		}
	}
	if content.Has(provider.ContentHealth) {
		if err := p.syncHealth(ctx, client, user, &res); err != nil {
			return res, err
		}
	}
	return res, nil
}

// syncActivities pages the activity list, stopping at the first already-synced
// activity in incremental mode, and upserts each activity's detail.
func (p *Provider) syncActivities(ctx context.Context, client *Client, user string, opts provider.SyncOptions, res *provider.SyncResult) error {
	const pageSize = 20
	for start := 0; ; {
		raw, err := client.ListActivities(ctx, start, pageSize)
		if err != nil {
			return err
		}
		acts, err := parseActivityList(raw)
		if err != nil {
			return err
		}
		if len(acts) == 0 {
			return nil
		}
		for _, a := range acts {
			labelID := a.labelID()
			if labelID == "" {
				continue
			}
			exists, err := p.store.ActivityExists(ctx, user, labelID)
			if err != nil {
				return err
			}
			if exists && opts.Mode != provider.SyncFull {
				return nil // incremental catch-up: reached known history
			}
			if err := p.syncOneActivity(ctx, client, user, a, res); err != nil {
				return err
			}
			if opts.Limit > 0 && res.Activities >= opts.Limit {
				return nil // bounded run
			}
		}
		start += len(acts)
		if len(acts) < pageSize {
			return nil // last page
		}
	}
}

// syncOneActivity fetches the detail sub-resources for one activity and upserts
// it. detail/splits/weather are best-effort (a fetch failure just drops that
// sub-resource — matching the Python path).
func (p *Provider) syncOneActivity(ctx context.Context, client *Client, user string, a rawActivity, res *provider.SyncResult) error {
	labelID := a.labelID()
	detailsRaw, _ := client.GetActivityDetails(ctx, labelID, activityDetailsMaxChart, activityDetailsMaxPoly)
	splitsRaw, _ := client.GetActivitySplits(ctx, labelID)
	weatherRaw, _ := client.GetActivityWeather(ctx, labelID)

	var weather *rawWeather
	if len(weatherRaw) > 0 {
		var w rawWeather
		if json.Unmarshal(weatherRaw, &w) == nil {
			weather = &w
		}
	}
	act := buildActivity(user, a, weather)
	laps := parseSplits(splitsRaw)
	ts := parseDetailsTimeseries(detailsRaw)
	if err := p.store.UpsertActivity(ctx, act, laps, ts, nil); err != nil {
		return err
	}
	res.Activities++
	res.ActivityLabelIDs = append(res.ActivityLabelIDs, labelID)
	if err := p.store.SetMeta(ctx, user, "last_label_id", labelID); err != nil {
		return err
	}
	return nil
}

// syncHealth refreshes the daily-health window (daily_health + daily_hrv) and the
// dashboard singleton. Walks most-recent → oldest, bailing after a week of
// consecutive empty days to avoid burning calls on idle accounts.
func (p *Provider) syncHealth(ctx context.Context, client *Client, user string, res *provider.SyncResult) error {
	today := time.Now().In(shanghaiZone)
	consecEmpty := 0
	for offset := 0; offset < healthWindowDays; offset++ {
		date := today.AddDate(0, 0, -offset).Format("2006-01-02")

		tsRaw, _ := client.GetTrainingStatus(ctx, date)
		usRaw, _ := client.GetUserSummary(ctx, date)
		sleepRaw, _ := client.GetSleepData(ctx, date)
		hrvRaw, _ := client.GetHRV(ctx, date)

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
	}
	return p.syncDashboard(ctx, client, user, today, res)
}

// syncDashboard pulls the most-recent metrics into the singleton dashboard row.
func (p *Provider) syncDashboard(ctx context.Context, client *Client, user string, today time.Time, res *provider.SyncResult) error {
	todayISO := today.Format("2006-01-02")
	yesterdayISO := today.AddDate(0, 0, -1).Format("2006-01-02")

	tsRaw, _ := client.GetTrainingStatus(ctx, todayISO)
	usRaw, _ := client.GetUserSummary(ctx, todayISO)
	hrvRaw, _ := client.GetHRV(ctx, yesterdayISO)
	ltRaw, _ := client.GetLactateThreshold(ctx)
	rpRaw, _ := client.GetRacePredictions(ctx)

	dash, preds := buildDashboard(user, tsRaw, usRaw, hrvRaw, ltRaw, rpRaw)
	if err := p.store.UpsertDashboard(ctx, dash); err != nil {
		return err
	}
	res.Health++
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
