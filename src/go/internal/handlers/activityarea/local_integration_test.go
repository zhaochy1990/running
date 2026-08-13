package activityarea

import (
	"context"
	"os"
	"testing"

	"github.com/zhaochy1990/stride/internal/config"
	"github.com/zhaochy1990/stride/internal/job"
	"github.com/zhaochy1990/stride/internal/storage"
)

func TestLocalUsualActivityAreaJob(t *testing.T) {
	if os.Getenv("STRIDE_RUN_LOCAL_ACTIVITY_AREA") != "1" {
		t.Skip("set STRIDE_RUN_LOCAL_ACTIVITY_AREA=1 to run against local MySQL")
	}
	configPath := os.Getenv("CONFIG_PATH")
	if configPath == "" {
		configPath = "config.local.yml"
	}
	userID := os.Getenv("STRIDE_ACTIVITY_AREA_TEST_USER_ID")
	if userID == "" {
		userID = "11c2e582-5a85-4633-81d2-df7e37ad7b48"
	}
	cfg := config.MustLoadActivityAreaRuntimeFrom(configPath)
	store, err := storage.Open(cfg.MySQL.DSN)
	if err != nil {
		t.Fatalf("open local MySQL: %v", err)
	}
	defer store.Close()
	if err := store.AutoMigrateUsers(context.Background()); err != nil {
		t.Fatalf("migrate local profile: %v", err)
	}
	result, err := New(store)(context.Background(), &job.Job{UserID: userID}, func(string, int) error { return nil })
	if err != nil {
		t.Fatalf("usual activity area job: %v", err)
	}
	// Result intentionally contains only status/count, never area coordinates.
	t.Logf("usual activity area result: %s", result)
}
