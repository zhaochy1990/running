// Package chinaath is a thin HTTP client for the 中国田径协会 (China Athletics
// Association) public competition-list API (api-changzheng.chinaath.com), the
// same backend the runchina.org.cn race list page calls. It fetches the full
// paginated competition catalogue via the official/searchCompetitionMls
// endpoint — a plain POST with a JSON body, no auth or signature, so unlike
// worldathletics there is no key-discovery step.
package chinaath

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"

	"go.uber.org/zap"

	"github.com/zhaochy1990/stride/internal/httpx"
	"github.com/zhaochy1990/stride/internal/logging"
)

// ProductionAPIURL is the public endpoint the 田协 race-list page uses.
const ProductionAPIURL = "https://api-changzheng.chinaath.com/changzheng-content-center-api/api/homePage/official/searchCompetitionMls"

// Config wires the client. PageSize is the upstream page size (100 keeps a
// full sync at ~30 requests); zero defaults to 100.
type Config struct {
	Endpoint string
	Timeout  time.Duration
	PageSize int
}

// Client is the 田协 competition-list client. It is safe for concurrent use.
type Client struct {
	endpoint string
	pageSize int
	hc       *http.Client
	log      *zap.Logger
}

// New returns a Client. A zero Timeout defaults to 60s, a zero PageSize to 100.
func New(cfg Config) *Client {
	if cfg.Timeout == 0 {
		cfg.Timeout = 60 * time.Second
	}
	if cfg.PageSize == 0 {
		cfg.PageSize = 100
	}
	return &Client{
		endpoint: cfg.Endpoint,
		pageSize: cfg.PageSize,
		hc:       &http.Client{Timeout: cfg.Timeout},
		log:      logging.Default(),
	}
}

// WithLogger returns a copy of the client that logs with l. nil falls back to
// the process logger (internal/logging.Default), which is nil-safe in tests.
func (c *Client) WithLogger(l *zap.Logger) *Client {
	cp := *c
	cp.log = l
	return &cp
}

// Endpoint exposes the endpoint the client talks to (for log context).
func (c *Client) Endpoint() string { return c.endpoint }

// logger returns the client's logger, defaulting to the process logger.
func (c *Client) logger() *zap.Logger {
	if c.log != nil {
		return c.log
	}
	return logging.Default()
}

// Race is one competition in the upstream catalogue, trimmed to the fields the
// race_calendar pipeline persists. RaceItem is kept raw (a stringified JSON
// array like "[\"全程\",\"半程\"]") — Items carries its parsed form, filled in by
// Races after each fetch; a malformed RaceItem leaves Items nil rather than
// failing the sync (the handler maps nil Items to racetypes.Unknown).
type Race struct {
	RaceID      int64    `json:"raceId"`
	RaceName    string   `json:"raceName"`
	RaceGrade   string   `json:"raceGrade"`
	RaceTime    string   `json:"raceTime"`
	RaceAddress string   `json:"raceAddress"`
	RaceItem    string   `json:"raceItem"`
	RaceScale   *string  `json:"raceScale"`
	Items       []string `json:"-"`
}

// pageRequest is the upstream request body for one page.
type pageRequest struct {
	PageNo   int `json:"pageNo"`
	PageSize int `json:"pageSize"`
}

// pageResponse is the upstream response envelope for one page.
type pageResponse struct {
	Success bool `json:"success"`
	Code    int  `json:"code"`
	Data    *struct {
		Results    []Race `json:"results"`
		PageNo     int    `json:"pageNo"`
		PageSize   int    `json:"pageSize"`
		PageCount  int    `json:"pageCount"`
		TotalCount int    `json:"totalCount"`
	} `json:"data"`
}

// Races fetches the full competition catalogue, page by page, and returns every
// race with Items parsed. Transient failures (5xx/429/network) are retried via
// httpx; an upstream "success":false envelope or a malformed response is
// terminal. A catalogue that reports zero pages yields an empty slice, not an
// error.
func (c *Client) Races(ctx context.Context) ([]Race, error) {
	var all []Race
	pageNo := 1
	for {
		var page pageResponse
		err := httpx.Do(ctx, func() error {
			body, err := json.Marshal(pageRequest{PageNo: pageNo, PageSize: c.pageSize})
			if err != nil {
				return err
			}
			req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.endpoint, bytes.NewReader(body))
			if err != nil {
				return err
			}
			req.Header.Set("Content-Type", "application/json")
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
			if err := json.Unmarshal(raw, &page); err != nil {
				return err
			}
			return nil
		})
		if err != nil {
			c.logger().Warn("chinaath: competition page request failed",
				zap.String("endpoint", c.endpoint),
				zap.Int("page", pageNo),
				zap.Error(err))
			return nil, err
		}
		if page.Data == nil {
			return nil, fmt.Errorf("chinaath: page %d response has no data envelope", pageNo)
		}
		all = append(all, page.Data.Results...)

		c.logger().Info("chinaath: competition page fetched",
			zap.String("endpoint", c.endpoint),
			zap.Int("page", pageNo),
			zap.Int("page_count", page.Data.PageCount),
			zap.Int("got", len(page.Data.Results)),
			zap.Int("total", len(all)),
		)

		if page.Data.PageCount <= 0 || pageNo >= page.Data.PageCount {
			break
		}
		pageNo++
	}

	for i := range all {
		all[i].Items = parseItems(all[i].RaceItem)
	}
	return all, nil
}

// parseItems decodes the upstream stringified JSON array ("[\"全程\",\"半程\"]")
// into its items. Anything malformed degrades to nil: one bad row must not fail
// the whole sync.
func parseItems(raw string) []string {
	if raw == "" {
		return nil
	}
	var items []string
	if err := json.Unmarshal([]byte(raw), &items); err != nil {
		return nil
	}
	return items
}
