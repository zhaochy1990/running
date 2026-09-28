// Package amap wraps the Amap (高德) web-service geocoding API. Amap returns
// GCJ-02 coordinates; every result is converted to WGS84 before leaving this
// package so callers can store it next to GPS-derived data (activity start
// fixes, RacePoint lat/lng) without remembering the offset.
package amap

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// DefaultGeocodeURL is the official v3 geocode endpoint.
const DefaultGeocodeURL = "https://restapi.amap.com/v3/geocode/geo"

// GeocodeResult is one resolved place in WGS84 decimal degrees.
type GeocodeResult struct {
	Name             string
	FormattedAddress string
	Latitude         float64
	Longitude        float64
	Level            string
}

// Client calls the geocode endpoint with a fixed key.
type Client struct {
	key      string
	endpoint string
	http     *http.Client
}

// New builds a client. An empty key leaves the client unusable (IsConfigured
// reports false) so the capability can ship dark, mirroring the COS and
// CityAIDraft patterns.
func New(apiKey string, timeout time.Duration) *Client {
	if timeout <= 0 {
		timeout = 5 * time.Second
	}
	endpoint := DefaultGeocodeURL
	return &Client{key: apiKey, endpoint: endpoint, http: &http.Client{Timeout: timeout}}
}

// NewWithEndpoint overrides the endpoint (tests and self-hosted proxies).
func NewWithEndpoint(apiKey, endpoint string, timeout time.Duration) *Client {
	client := New(apiKey, timeout)
	if endpoint != "" {
		client.endpoint = endpoint
	}
	return client
}

// IsConfigured reports whether geocoding can run.
func (c *Client) IsConfigured() bool { return c != nil && c.key != "" }

// Geocode resolves one address, optionally narrowed by city (Chinese city
// name like 盐城市). It returns the first Amap hit converted to WGS84.
func (c *Client) Geocode(ctx context.Context, address, city string) (*GeocodeResult, error) {
	if !c.IsConfigured() {
		return nil, errors.New("amap: client not configured")
	}
	query := url.Values{}
	query.Set("key", c.key)
	query.Set("address", address)
	if city != "" {
		query.Set("city", city)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.endpoint+"?"+query.Encode(), nil)
	if err != nil {
		return nil, fmt.Errorf("amap: build request: %w", err)
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, fmt.Errorf("amap: geocode: %w", err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return nil, fmt.Errorf("amap: read response: %w", err)
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("amap: provider returned HTTP %d", resp.StatusCode)
	}
	var payload struct {
		Status   string `json:"status"`
		Info     string `json:"info"`
		Geocodes []struct {
			FormattedAddress string `json:"formatted_address"`
			Location         string `json:"location"`
			Level            string `json:"level"`
			Name             string `json:"name"`
		} `json:"geocodes"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		return nil, fmt.Errorf("amap: decode response: %w", err)
	}
	if payload.Status != "1" {
		return nil, fmt.Errorf("amap: provider status %q info %q", payload.Status, payload.Info)
	}
	if len(payload.Geocodes) == 0 {
		return nil, errors.New("amap: no geocode result")
	}
	first := payload.Geocodes[0]
	lng, lat, err := parseLocation(first.Location)
	if err != nil {
		return nil, fmt.Errorf("amap: %w", err)
	}
	wgsLat, wgsLng := GCJ02ToWGS84(lat, lng)
	return &GeocodeResult{
		Name:             first.Name,
		FormattedAddress: first.FormattedAddress,
		Latitude:         wgsLat,
		Longitude:        wgsLng,
		Level:            first.Level,
	}, nil
}

// parseLocation accepts Amap's "lng,lat" pair (longitude first).
func parseLocation(location string) (lng, lat float64, err error) {
	parts := strings.Split(strings.TrimSpace(location), ",")
	if len(parts) != 2 {
		return 0, 0, fmt.Errorf("unexpected location %q", location)
	}
	if lng, err = strconv.ParseFloat(parts[0], 64); err != nil {
		return 0, 0, fmt.Errorf("parse longitude %q: %w", parts[0], err)
	}
	if lat, err = strconv.ParseFloat(parts[1], 64); err != nil {
		return 0, 0, fmt.Errorf("parse latitude %q: %w", parts[1], err)
	}
	return lng, lat, nil
}
