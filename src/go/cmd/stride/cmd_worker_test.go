package main

import (
	"context"
	"testing"

	areaHandler "github.com/zhaochy1990/stride/internal/handlers/activityarea"
	"github.com/zhaochy1990/stride/internal/handlers/watchsync"
	"github.com/zhaochy1990/stride/internal/job"
	"github.com/zhaochy1990/stride/internal/racedetection"
	"github.com/zhaochy1990/stride/internal/storage"
)

func TestRegisterHandlersIncludesUsualActivityArea(t *testing.T) {
	reg := job.NewRegistry()
	resolve := func(context.Context, string) (watchsync.Provider, error) { return nil, nil }
	registerHandlers(reg, resolve, &storage.Store{}, racedetection.New(nil), 1)
	if _, ok := reg.Handler(areaHandler.JobType); !ok {
		t.Fatalf("handler %q is not registered", areaHandler.JobType)
	}
}
