package worldathletics

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"sync"

	"go.uber.org/zap"

	"github.com/zhaochy1990/stride/internal/httpx"
)

// ErrAPIKeyNotFound reports that the World Athletics site bundle no longer
// carries the AppSync config the client expects (page or chunk structure
// changed upstream). It is deterministic: retrying discovery won't help.
var ErrAPIKeyNotFound = errors.New("worldathletics: AppSync endpoint/api-key not found in site bundle")

// ErrProbeRejected reports that a discovered API key did not authenticate
// against the GraphQL endpoint (or the response was malformed). It is
// deterministic for a given key.
var ErrProbeRejected = errors.New("worldathletics: discovered API key rejected by GraphQL endpoint")

// APIKeyInfo is the current public AppSync configuration World Athletics
// embeds in its site's JS bundle.
type APIKeyInfo struct {
	Endpoint string
	APIKey   string
}

// WithCredentials returns a copy of the client talking to a different endpoint
// with a different API key, sharing the same http.Client (and timeout). Used by
// the calendar handler when a pipeline step discovered fresher credentials.
func (c *Client) WithCredentials(endpoint, apiKey string) *Client {
	cp := *c
	cp.endpoint = endpoint
	cp.apiKey = apiKey
	return &cp
}

// maxDiscoveryChunks bounds how many initial page scripts are scanned for the
// config object, so an adversarial/accidental HTML never causes an unbounded
// fan-out. The config chunk sits in the initial set (~30 scripts today).
const maxDiscoveryChunks = 64

// discoveryConcurrency bounds parallel chunk fetches during key discovery.
const discoveryConcurrency = 8

// scriptSrcRe matches the initial `<script src="...js">` tags of a Next.js page.
var scriptSrcRe = regexp.MustCompile(`<script[^>]+src="([^"]+\.js)"`)

// apiKeyConfigRe matches the site config object holding the main GraphQL
// AppSync endpoint and its key, e.g.
//
//	graphql:{endpoint:"https://graphql-prod-.../graphql",...,apiKey:"da2-..."}
//
// It matches the *first* `graphql:{` object (the main API), not the regional or
// CIS variants that follow, and survives an endpoint change upstream.
var apiKeyConfigRe = regexp.MustCompile(`graphql:\{[^{}]*?endpoint:"([^"]+)"[^{}]*?apiKey:"([^"]+)"`)

// DiscoverAPIKey fetches the WA site page, scans its initial JS chunks, and
// extracts the current AppSync endpoint + API key the site itself uses. The
// key is public (embedded in the JS bundle); this is how the pipeline keeps
// working when World Athletics rotates it. It returns ErrAPIKeyNotFound if the
// page/chunk structure changes and the config can no longer be located.
func (c *Client) DiscoverAPIKey(ctx context.Context, pageURL string) (APIKeyInfo, error) {
	html, err := c.getText(ctx, pageURL)
	if err != nil {
		c.logger().Error("worldathletics: key discovery failed to fetch the site page",
			zap.String("page", pageURL),
			zap.Error(err))
		return APIKeyInfo{}, fmt.Errorf("worldathletics: fetch site page: %w", err)
	}
	base := chunkBaseURL(pageURL)
	if base == "" {
		return APIKeyInfo{}, ErrAPIKeyNotFound
	}
	srcs := dedupe(pageScripts(html))
	if len(srcs) > maxDiscoveryChunks {
		srcs = srcs[:maxDiscoveryChunks]
	}
	c.logger().Debug("worldathletics: key discovery scanning site chunks",
		zap.String("page", pageURL),
		zap.Int("chunks", len(srcs)))

	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	found := make(chan APIKeyInfo, 1)
	sem := make(chan struct{}, discoveryConcurrency)
	var wg sync.WaitGroup
	for _, src := range srcs {
		wg.Add(1)
		go func(src string) {
			defer wg.Done()
			select {
			case sem <- struct{}{}:
				defer func() { <-sem }()
			case <-ctx.Done():
				return
			}
			js, err := c.getText(ctx, base+src)
			if err != nil {
				c.logger().Debug("worldathletics: key discovery chunk fetch failed",
					zap.String("chunk", base+src),
					zap.Error(err))
				return
			}
			if info, ok := extractAPIKeyInfo(js); ok {
				c.logger().Info("worldathletics: key discovery found API config",
					zap.String("endpoint", info.Endpoint),
					zap.String("api_key", MaskKey(info.APIKey)),
					zap.String("chunk", base+src))
				select {
				case found <- info:
					cancel() // one hit is enough; stop the remaining fetches
				case <-ctx.Done():
				}
			}
		}(src)
	}
	wg.Wait()
	select {
	case info := <-found:
		return info, nil
	default:
		c.logger().Error("worldathletics: key discovery found no API config in the site bundle",
			zap.String("page", pageURL),
			zap.Int("chunks_scanned", len(srcs)),
			zap.String("error_code", "api_key_not_found"))
		return APIKeyInfo{}, ErrAPIKeyNotFound
	}
}

// VerifyAPIKey confirms that key authenticates against endpoint with a tiny
// introspection probe (auth happens before field resolution, so a successful
// probe proves the key is valid without fetching any calendar data). A GraphQL
// error or a malformed response is wrapped in ErrProbeRejected; transport/5xx
// failures stay retryable.
func (c *Client) VerifyAPIKey(ctx context.Context, endpoint, apiKey string) error {
	payload, err := json.Marshal(map[string]any{"query": "{ __schema { queryType { name } } }"})
	if err != nil {
		return err
	}
	err = httpx.Do(ctx, func() error {
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(payload))
		if err != nil {
			return err
		}
		req.Header.Set("Content-Type", "application/json")
		if apiKey != "" {
			req.Header.Set("x-api-key", apiKey)
		}
		resp, err := c.hc.Do(req)
		if err != nil {
			return err
		}
		defer resp.Body.Close()
		raw, err := io.ReadAll(resp.Body)
		if err != nil {
			return err
		}
		if resp.StatusCode != http.StatusOK {
			return &httpx.StatusError{Code: resp.StatusCode, Body: string(raw)}
		}
		var env struct {
			Errors []struct {
				Message string `json:"message"`
			} `json:"errors"`
		}
		if err := json.Unmarshal(raw, &env); err != nil {
			return fmt.Errorf("%w: %v", ErrProbeRejected, err)
		}
		if len(env.Errors) > 0 {
			return fmt.Errorf("%w: %s", ErrProbeRejected, env.Errors[0].Message)
		}
		return nil
	})
	if err != nil {
		if errors.Is(err, ErrProbeRejected) {
			c.logger().Warn("worldathletics: discovered API key rejected by GraphQL endpoint",
				zap.String("endpoint", endpoint),
				zap.String("api_key", MaskKey(apiKey)),
				zap.Error(err))
		} else {
			c.logger().Warn("worldathletics: API key verification failed (transport)",
				zap.String("endpoint", endpoint),
				zap.Error(err))
		}
		return err
	}
	c.logger().Info("worldathletics: discovered API key verified",
		zap.String("endpoint", endpoint),
		zap.String("api_key", MaskKey(apiKey)))
	return nil
}

// getText fetches url and returns its body, retrying transient failures via
// httpx. A non-2xx is a terminal StatusError.
func (c *Client) getText(ctx context.Context, url string) (string, error) {
	var body string
	err := httpx.Do(ctx, func() error {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
		if err != nil {
			c.logger().Debug("worldathletics: get failed",
				zap.String("url", url),
				zap.Error(err))
			return err
		}
		req.Header.Set("User-Agent", "Mozilla/5.0 (compatible; stride-bot/1.0)")
		resp, err := c.hc.Do(req)
		if err != nil {
			c.logger().Debug("worldathletics: get failed",
				zap.String("url", url),
				zap.Error(err))
			return err
		}
		defer resp.Body.Close()
		raw, err := io.ReadAll(resp.Body)
		if err != nil {
			return err
		}
		if resp.StatusCode != http.StatusOK {
			c.logger().Debug("worldathletics: get non-2xx",
				zap.String("url", url),
				zap.Int("status", resp.StatusCode))
			return &httpx.StatusError{Code: resp.StatusCode, Body: string(raw)}
		}
		body = string(raw)
		return nil
	})
	return body, err
}

// chunkBaseURL returns "scheme://host" for a page URL, used to resolve the
// absolute script paths Next.js emits. Empty when pageURL is malformed.
func chunkBaseURL(pageURL string) string {
	u, err := url.Parse(pageURL)
	if err != nil || u.Scheme == "" || u.Host == "" {
		return ""
	}
	return u.Scheme + "://" + u.Host
}

// pageScripts lists the initial JS chunk paths of a Next.js page, in order.
func pageScripts(html string) []string {
	out := make([]string, 0, 16)
	for _, m := range scriptSrcRe.FindAllStringSubmatch(html, -1) {
		out = append(out, m[1])
	}
	return out
}

func dedupe(in []string) []string {
	seen := make(map[string]struct{}, len(in))
	out := make([]string, 0, len(in))
	for _, s := range in {
		if _, ok := seen[s]; ok {
			continue
		}
		seen[s] = struct{}{}
		out = append(out, s)
	}
	return out
}

// extractAPIKeyInfo pulls the endpoint + key out of the site config object.
func extractAPIKeyInfo(js string) (APIKeyInfo, bool) {
	m := apiKeyConfigRe.FindStringSubmatch(js)
	if m == nil || m[1] == "" || m[2] == "" {
		return APIKeyInfo{}, false
	}
	return APIKeyInfo{Endpoint: m[1], APIKey: m[2]}, true
}
