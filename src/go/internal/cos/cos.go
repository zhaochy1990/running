// Package cos uploads worker-generated assets to Tencent Cloud COS. It mirrors
// the auth-service's internal/cos wrapper so both services sign and address the
// same bucket identically.
package cos

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	cosgo "github.com/tencentyun/cos-go-sdk-v5"
)

// ErrNotFound is returned (wrapped) by Get and Delete for a missing object, so
// callers can distinguish "absent" from "broken" with errors.Is and map it to
// their own sentinel (tsstore.ErrNotFound does exactly that).
var ErrNotFound = errors.New("cos: object not found")

// Config is the bucket credentials plus the public origin used to build URLs.
type Config struct {
	SecretID  string
	SecretKey string
	Bucket    string
	Region    string
	// BaseURL is the public (or later CDN) origin prepended to an object key
	// when building the URL stored on the activity row.
	BaseURL string
}

// configured reports whether the bucket can be signed and addressed.
func (c Config) configured() bool {
	return c.SecretID != "" && c.SecretKey != "" && c.Bucket != "" && c.Region != "" && c.BaseURL != ""
}

// Client is a thin, configured COS client. A zero-config Client is inert;
// Configured reports which it is.
type Client struct {
	cfg Config
	cli *cosgo.Client
}

// NewClient builds a client for cfg. It returns a usable-but-inert client when
// cfg is incomplete so the worker can boot without bucket credentials.
func NewClient(cfg Config) *Client {
	if !cfg.configured() {
		return &Client{cfg: cfg}
	}
	// A parse failure cannot happen for the well-formed URL built from
	// non-empty fields; if it ever does, the inert client keeps boot
	// fail-open (thumbnails are cosmetic).
	cli, err := newSignedClient(cfg)
	if err != nil {
		return &Client{cfg: cfg}
	}
	return &Client{cfg: cfg, cli: cli}
}

// NewPrivateClient builds a client for a private bucket — one with no public
// origin to build URLs from, like the timeseries blob store (devops#784). It
// differs from NewClient in two deliberate ways: BaseURL is irrelevant (only
// PublicURL reads it), and an incomplete config is an explicit error, never an
// inert client — private-bucket data paths are load-bearing and must not
// silently degrade the way the cosmetic thumbnail path may.
func NewPrivateClient(cfg Config) (*Client, error) {
	var missing []string
	for _, f := range []struct {
		name, value string
	}{
		{"secret-id", cfg.SecretID}, {"secret-key", cfg.SecretKey},
		{"bucket", cfg.Bucket}, {"region", cfg.Region},
	} {
		if f.value == "" {
			missing = append(missing, f.name)
		}
	}
	if len(missing) > 0 {
		return nil, fmt.Errorf("cos: private bucket config incomplete, missing %s", strings.Join(missing, ", "))
	}
	cli, err := newSignedClient(cfg)
	if err != nil {
		return nil, err
	}
	return &Client{cfg: cfg, cli: cli}, nil
}

// newSignedClient builds the SDK client with the same signing setup for both
// constructors.
func newSignedClient(cfg Config) (*cosgo.Client, error) {
	httpCli := &http.Client{Timeout: 30 * time.Second}
	httpCli.Transport = &cosgo.AuthorizationTransport{
		SecretID:  cfg.SecretID,
		SecretKey: cfg.SecretKey,
		Transport: &http.Transport{},
	}
	bucketURL, err := url.Parse(fmt.Sprintf("https://%s.cos.%s.myqcloud.com", cfg.Bucket, cfg.Region))
	if err != nil {
		return nil, fmt.Errorf("cos: parse bucket URL: %w", err)
	}
	return cosgo.NewClient(&cosgo.BaseURL{BucketURL: bucketURL}, httpCli), nil
}

// Configured reports whether this client can upload. Callers treat an
// unconfigured bucket as "skip this feature", never as an error: route
// thumbnails are cosmetic and must not fail a sync.
func (c *Client) Configured() bool { return c.cli != nil }

// Upload stores r at key. The bucket must allow public reads: the URL returned
// by PublicURL is handed straight to the miniprogram.
func (c *Client) Upload(ctx context.Context, key string, r io.Reader, contentType string) error {
	if !c.Configured() {
		return fmt.Errorf("cos: not configured")
	}
	_, err := c.cli.Object.Put(ctx, key, r, &cosgo.ObjectPutOptions{
		ObjectPutHeaderOptions: &cosgo.ObjectPutHeaderOptions{ContentType: contentType},
	})
	if err != nil {
		return fmt.Errorf("cos: upload %s: %w", key, err)
	}
	return nil
}

// Get fetches the whole object at key. A missing object returns an error
// wrapping ErrNotFound.
func (c *Client) Get(ctx context.Context, key string) ([]byte, error) {
	if !c.Configured() {
		return nil, fmt.Errorf("cos: not configured")
	}
	resp, err := c.cli.Object.Get(ctx, key, nil)
	if err != nil {
		if isNotFound(err) {
			return nil, fmt.Errorf("cos: get %s: %w", key, ErrNotFound)
		}
		return nil, fmt.Errorf("cos: get %s: %w", key, err)
	}
	defer resp.Body.Close()
	b, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("cos: read %s: %w", key, err)
	}
	return b, nil
}

// List calls fn with the key and last-modified time of every object under
// prefix, walking the marker pagination. Iteration order is the bucket's
// lexicographic key order. An error returned by fn aborts the walk and is
// returned as-is, so a caller can both fail and stop early (with its own
// sentinel). modTime is the zero time when the server's timestamp cannot be
// parsed — callers with age rules must treat that as "age unknown", never
// "old".
func (c *Client) List(ctx context.Context, prefix string, fn func(key string, modTime time.Time) error) error {
	if !c.Configured() {
		return fmt.Errorf("cos: not configured")
	}
	const maxKeys = 1000
	marker := ""
	for {
		res, _, err := c.cli.Bucket.Get(ctx, &cosgo.BucketGetOptions{
			Prefix: prefix, Marker: marker, MaxKeys: maxKeys,
		})
		if err != nil {
			return fmt.Errorf("cos: list %q: %w", prefix, err)
		}
		for _, obj := range res.Contents {
			if err := fn(obj.Key, parseCOSTime(obj.LastModified)); err != nil {
				return err
			}
		}
		if !res.IsTruncated {
			return nil
		}
		// S3/COS semantics: NextMarker is only guaranteed with a delimiter;
		// otherwise continue after the last key seen.
		next := res.NextMarker
		if next == "" && len(res.Contents) > 0 {
			next = res.Contents[len(res.Contents)-1].Key
		}
		if next == "" || next == marker {
			return fmt.Errorf("cos: list %q: pagination stalled at %q", prefix, marker)
		}
		marker = next
	}
}

// cosTimeLayouts are the timestamp forms COS's XML List body has been observed
// to return (ISO-8601 with and without millis, space-separated, and the two
// RFC-1123 forms S3-compatible layers emit).
var cosTimeLayouts = []string{
	"2006-01-02T15:04:05.000Z",
	time.RFC3339,
	"2006-01-02T15:04:05Z",
	"2006-01-02 15:04:05",
	time.RFC1123,
	time.RFC1123Z,
}

// parseCOSTime parses a COS LastModified string; the zero time means unknown.
func parseCOSTime(s string) time.Time {
	for _, layout := range cosTimeLayouts {
		if t, err := time.Parse(layout, s); err == nil {
			return t.UTC()
		}
	}
	return time.Time{}
}

// isNotFound reports whether err is the SDK's 404 ErrorResponse, unwrapping
// the SDK's retry wrapper via errors.As.
func isNotFound(err error) bool {
	var apiErr *cosgo.ErrorResponse
	if errors.As(err, &apiErr) && apiErr.Response != nil {
		return apiErr.Response.StatusCode == http.StatusNotFound
	}
	return false
}

// PublicURL is the stable public URL of an uploaded object.
func (c *Client) PublicURL(key string) string {
	return strings.TrimSuffix(c.cfg.BaseURL, "/") + "/" + key
}

// Delete removes the object at key. A missing object is reported as an error
// wrapping ErrNotFound (COS deletes usually answer 204 regardless; the 404
// branch is belt and braces). Callers treat failures per their own policy
// (account erasure is fail-open and only logs).
func (c *Client) Delete(ctx context.Context, key string) error {
	if !c.Configured() {
		return fmt.Errorf("cos: not configured")
	}
	if _, err := c.cli.Object.Delete(ctx, key); err != nil {
		if isNotFound(err) {
			return fmt.Errorf("cos: delete %s: %w", key, ErrNotFound)
		}
		return fmt.Errorf("cos: delete %s: %w", key, err)
	}
	return nil
}
