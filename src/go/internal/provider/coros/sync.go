// sync.go is the COROS adapter: it implements provider.Provider and orchestrates
// a sync (incremental activity scan → detail fetch → normalize → store, plus
// daily health). SyncUser owns the whole run and writes via storage.Writer
// (DI), so the same core backs both the CLI and a future worker job handler.
package coros

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/zhaochy1990/stride/internal/provider"
	"github.com/zhaochy1990/stride/internal/storage"
)

const providerName = "coros"

// Provider is the COROS watch-data adapter.
type Provider struct {
	provider.BaseProvider
	store storage.Writer
	creds CredentialStore
	delay time.Duration

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

// WithClientFactory overrides how the HTTP client is built (used by tests to
// inject an httptest-backed client).
func WithClientFactory(f func(c Credentials, save CredentialSaver) *Client) ProviderOption {
	return func(p *Provider) { p.newClient = f }
}

// WithProviderRequestDelay sets the default per-request rate-limit pause.
func WithProviderRequestDelay(d time.Duration) ProviderOption {
	return func(p *Provider) { p.delay = d }
}

// Info declares the COROS provider capabilities. v1 advertises only HRV detail;
// push/exercise stay unsupported (BaseProvider → FeatureNotSupported).
func (p *Provider) Info() provider.ProviderInfo {
	return provider.ProviderInfo{
		Name:         providerName,
		DisplayName:  "高驰",
		Regions:      []string{"global", "cn", "eu"},
		Capabilities: provider.Capabilities{provider.CapSyncHRVDetail: true},
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
	return res, nil
}

// listItem is one entry of the /activity/query dataList. Date is flexible
// because COROS reports it as a number (YYYYMMDD) in real payloads.
type listItem struct {
	LabelID   string     `json:"labelId"`
	SportType int        `json:"sportType"`
	Date      flexString `json:"date"`
}

// syncActivities collects the activity list (paging, stopping at the first
// already-synced activity in incremental mode), then fetches + upserts each
// activity's detail. It emits per-activity progress so a long full sync is
// legible on the job row.
//
// NOTE: detail fetch is sequential for v1 (correctness first); the client's
// re-login barrier already supports the parallel fetch that opts.jobs will drive
// in a follow-up.
func (p *Provider) syncActivities(ctx context.Context, client *Client, user string, opts provider.SyncOptions, res *provider.SyncResult) error {
	items, err := p.collectActivities(ctx, client, user, opts)
	if err != nil {
		return err
	}
	total := len(items)
	emitProgress(opts.Progress, "activities", 0, total, pctInBand(0, total, 10, 80))
	for i, item := range items {
		if err := p.syncOneActivity(ctx, client, user, item, res); err != nil {
			return err
		}
		emitProgress(opts.Progress, "activities", i+1, total, pctInBand(i+1, total, 10, 80))
	}
	return nil
}

// collectActivities pages the activity list and returns the items to sync,
// stopping at the first already-synced activity in incremental mode and honoring
// opts.Limit. Full mode collects known activities too (re-scan).
func (p *Provider) collectActivities(ctx context.Context, client *Client, user string, opts provider.SyncOptions) ([]listItem, error) {
	const pageSize = 20
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
			exists, err := p.store.ActivityExists(ctx, user, item.LabelID)
			if err != nil {
				return nil, err
			}
			if exists && opts.Mode != provider.SyncFull {
				return items, nil // incremental catch-up: reached known history
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

func (p *Provider) syncOneActivity(ctx context.Context, client *Client, user string, item listItem, res *provider.SyncResult) error {
	raw, err := client.GetActivityDetail(ctx, item.LabelID, item.SportType)
	if err != nil {
		return err
	}
	a, laps, ts, zones, err := ParseActivityDetail(user, item.LabelID, parseListDate(string(item.Date)), raw)
	if err != nil {
		return err
	}
	if err := p.store.UpsertActivity(ctx, a, laps, ts, zones); err != nil {
		return err
	}
	res.Activities++
	res.ActivityLabelIDs = append(res.ActivityLabelIDs, item.LabelID)
	if err := p.store.SetMeta(ctx, user, "last_label_id", item.LabelID); err != nil {
		return err
	}
	return nil
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

// syncHealth refreshes daily_health from /analyse/query.
//
// NOTE: dashboard + daily_hrv + race_predictions are a documented follow-up
// (their payload shapes need confirming against a captured response); v1 syncs
// daily_health, which is enough for the shadow reconcile of the health domain.
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
		date := d.Date
		if date == "" {
			date = d.HappenDay.String()
		}
		if date == "" {
			continue
		}
		h := &storage.DailyHealth{
			UserID:            user,
			Date:              date,
			ATI:               d.ATI,
			CTI:               d.CTI,
			RHR:               firstInt(d.TestRhr, d.Rhr),
			DistanceM:         d.Distance,
			DurationS:         d.Duration,
			TrainingLoadRatio: d.TrainingLoadRatio,
			Fatigue:           firstFloat(d.TiredRate, d.Fatigue),
			Provider:          providerName,
		}
		if err := p.store.UpsertDailyHealth(ctx, h); err != nil {
			return err
		}
		res.Health++
		res.HealthDates = append(res.HealthDates, date)
		emitProgress(progress, "health", i+1, total, pctInBand(i+1, total, 80, 95))
	}
	return nil
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
// progress
// ─────────────────────────────────────────────────────────────────────────────

// emitProgress sends a {phase, current, total, percent} event if cb is non-nil.
func emitProgress(cb provider.ProgressCallback, phase string, current, total, percent int) {
	if cb == nil {
		return
	}
	cb(provider.SyncProgress{
		"phase":   phase,
		"current": current,
		"total":   total,
		"percent": percent,
	})
}

// pctInBand maps current/total onto the [lo, hi] percent band for a phase. A
// zero total yields lo (nothing to do in this phase yet).
func pctInBand(current, total, lo, hi int) int {
	if total <= 0 {
		return lo
	}
	if current > total {
		current = total
	}
	return lo + (hi-lo)*current/total
}

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
