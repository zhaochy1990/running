package storage

import (
	"context"
	"sync"
)

type CalibrationReader interface {
	ReadEffectiveRunningCalibration(context.Context, string, string, CalibrationMode) (CalibrationBundle, error)
}
type calibrationCacheKey struct{}
type calibrationCache struct {
	mu      sync.Mutex
	bundles map[string]CalibrationBundle
}

// WithCalibrationCache scopes reuse to one computation, keyed by user/day/mode.
func WithCalibrationCache(ctx context.Context) context.Context {
	if _, ok := ctx.Value(calibrationCacheKey{}).(*calibrationCache); ok {
		return ctx
	}
	return context.WithValue(ctx, calibrationCacheKey{}, &calibrationCache{bundles: map[string]CalibrationBundle{}})
}
func ReadCachedRunningCalibration(ctx context.Context, r CalibrationReader, user, day string, mode CalibrationMode) (CalibrationBundle, error) {
	c, _ := ctx.Value(calibrationCacheKey{}).(*calibrationCache)
	if c == nil {
		return r.ReadEffectiveRunningCalibration(ctx, user, day, mode)
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	key := user + "/" + day + "/" + string(mode)
	if b, ok := c.bundles[key]; ok {
		return b, nil
	}
	b, err := r.ReadEffectiveRunningCalibration(ctx, user, day, mode)
	if err == nil {
		c.bundles[key] = b
	}
	return b, err
}
