// Package worldathletics is a thin HTTP client for World Athletics' public
// AWS AppSync GraphQL API (worldathletics.org). It fetches the competition
// calendar of a competition group (currently the label road races) via the
// getMinisiteCalendarEvents query — the same query the site's calendar-results
// page runs server-side. See docs: the endpoint and API key are public (the key
// is embedded in the WA site's JS bundle); no auth is needed beyond the header.
package worldathletics

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

// Config wires the client. Endpoint and APIKey mirror the AppSync setup the WA
// site itself uses.
type Config struct {
	Endpoint string
	APIKey   string
	Timeout  time.Duration
}

// Client is the World Athletics GraphQL client. It is safe for concurrent use.
type Client struct {
	endpoint string
	apiKey   string
	hc       *http.Client
	log      *zap.Logger
}

// New returns a Client. A zero Timeout defaults to 60s.
func New(cfg Config) *Client {
	if cfg.Timeout == 0 {
		cfg.Timeout = 60 * time.Second
	}
	return &Client{
		endpoint: cfg.Endpoint,
		apiKey:   cfg.APIKey,
		hc:       &http.Client{Timeout: cfg.Timeout},
	}
}

// WithLogger returns a copy of the client that logs with l. nil falls back to
// the process logger (internal/logging.Default), which is nil-safe in tests.
func (c *Client) WithLogger(l *zap.Logger) *Client {
	cp := *c
	cp.log = l
	return &cp
}

// logger returns the client's logger, defaulting to the process logger.
func (c *Client) logger() *zap.Logger {
	if c.log != nil {
		return c.log
	}
	return logging.Default()
}

// Endpoint exposes the endpoint the client talks to (for log context).
func (c *Client) Endpoint() string { return c.endpoint }

// MaskKey shortens an API key for logs, e.g. "da2-q7to...3abk5u". The key is
// public, but logs should still avoid echoing full secrets by habit.
func MaskKey(k string) string {
	if len(k) <= 8 {
		return "***"
	}
	return k[:4] + "..." + k[len(k)-4:]
}

// Event is one competition in a calendar season, mirroring the CalendarEvent
// shape returned by getMinisiteCalendarEvents. IaafID is the legacy World
// Athletics event id and is null for modern events.
type Event struct {
	ID                        int64  `json:"id"`
	IaafID                    *int64 `json:"iaafId"`
	HasResults                bool   `json:"hasResults"`
	HasStartlist              bool   `json:"hasStartlist"`
	HasAPIResults             bool   `json:"hasApiResults"`
	HasCompetitionInformation bool   `json:"hasCompetitionInformation"`
	Disciplines               string `json:"disciplines"`
	RankingCategory           string `json:"rankingCategory"`
	CompetitionSubgroup       string `json:"competitionSubgroup"`
	Name                      string `json:"name"`
	Venue                     string `json:"venue"`
	Country                   string `json:"country"`
	StartDate                 string `json:"startDate"`
	EndDate                   string `json:"endDate"`
	DateRange                 string `json:"dateRange"`
}

// minisiteCalendarResponse is the GraphQL response envelope for
// getMinisiteCalendarEvents. GetMinisiteCalendarEvents is null for a season
// that has no events yet (e.g. a future year), so it is a pointer.
type minisiteCalendarResponse struct {
	Data *struct {
		GetMinisiteCalendarEvents *struct {
			Results []Event `json:"results"`
		} `json:"getMinisiteCalendarEvents"`
	} `json:"data"`
	Errors []struct {
		Message string `json:"message"`
	} `json:"errors"`
}

// minisiteCalendarQuery selects the event fields persisted to MySQL. It must
// stay in sync with the Event struct and the storage model.
const minisiteCalendarQuery = `query getMinisiteCalendarEvents($season: String, $competitionGroupId: Int, $competitionSubgroupId: Int) {
  getMinisiteCalendarEvents(season: $season, competitionGroupId: $competitionGroupId, competitionSubgroupId: $competitionSubgroupId) {
    results {
      id
      iaafId
      hasResults
      hasStartlist
      hasApiResults
      hasCompetitionInformation
      disciplines
      rankingCategory
      competitionSubgroup
      name
      venue
      country
      startDate
      endDate
      dateRange
    }
  }
}`

// MinisiteCalendar fetches the calendar events of one season for a competition
// group. competitionSubgroupID 0 means "all subgroups". A season with no events
// (e.g. a future year) returns an empty slice, not an error. Transient failures
// (5xx/429/network) are retried via httpx; a malformed response or a GraphQL
// error is terminal.
func (c *Client) MinisiteCalendar(ctx context.Context, season string, competitionGroupID, competitionSubgroupID int) ([]Event, error) {
	payload, err := json.Marshal(map[string]any{
		"operationName": "getMinisiteCalendarEvents",
		"variables": map[string]any{
			"season":                season,
			"competitionGroupId":    competitionGroupID,
			"competitionSubgroupId": competitionSubgroupID,
		},
		"query": minisiteCalendarQuery,
	})
	if err != nil {
		return nil, err
	}

	var events []Event
	err = httpx.Do(ctx, func() error {
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.endpoint, bytes.NewReader(payload))
		if err != nil {
			return err
		}
		req.Header.Set("Content-Type", "application/json")
		if c.apiKey != "" {
			req.Header.Set("x-api-key", c.apiKey)
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

		var env minisiteCalendarResponse
		if err := json.Unmarshal(raw, &env); err != nil {
			return err
		}
		if len(env.Errors) > 0 {
			return fmt.Errorf("worldathletics: graphql error: %s", env.Errors[0].Message)
		}
		if env.Data == nil || env.Data.GetMinisiteCalendarEvents == nil {
			events = nil
			return nil
		}
		events = env.Data.GetMinisiteCalendarEvents.Results
		return nil
	})
	if err != nil {
		c.logger().Warn("worldathletics: minisite calendar request failed",
			zap.String("season", season),
			zap.String("endpoint", c.endpoint),
			zap.Error(err))
		return events, err
	}
	c.logger().Info("worldathletics: minisite calendar fetched",
		zap.String("season", season),
		zap.String("endpoint", c.endpoint),
		zap.Int("events", len(events)),
	)
	return events, nil
}
