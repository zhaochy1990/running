// Package cos uploads worker-generated assets to Tencent Cloud COS. It mirrors
// the auth-service's internal/cos wrapper so both services sign and address the
// same bucket identically.
package cos

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	cosgo "github.com/tencentyun/cos-go-sdk-v5"
)

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
	var cli *cosgo.Client
	if cfg.configured() {
		httpCli := &http.Client{Timeout: 30 * time.Second}
		httpCli.Transport = &cosgo.AuthorizationTransport{
			SecretID:  cfg.SecretID,
			SecretKey: cfg.SecretKey,
			Transport: &http.Transport{},
		}
		bucketURL, err := url.Parse(fmt.Sprintf("https://%s.cos.%s.myqcloud.com", cfg.Bucket, cfg.Region))
		if err != nil {
			return &Client{cfg: cfg}
		}
		cli = cosgo.NewClient(&cosgo.BaseURL{BucketURL: bucketURL}, httpCli)
	}
	return &Client{cfg: cfg, cli: cli}
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

// PublicURL is the stable public URL of an uploaded object.
func (c *Client) PublicURL(key string) string {
	return strings.TrimSuffix(c.cfg.BaseURL, "/") + "/" + key
}
