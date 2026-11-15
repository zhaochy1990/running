package api

// Explicitly gated local-only UI test harness: real GIN, RS256 verification,
// MySQL storage and FileStore. No production test route or network fallback.
import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"github.com/gin-gonic/gin"
	mysql "github.com/go-sql-driver/mysql"
	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
	"github.com/zhaochy1990/stride/internal/compute/calibration"
	"github.com/zhaochy1990/stride/internal/storage"
	"github.com/zhaochy1990/stride/internal/tsstore"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestCalibrationClientServer(t *testing.T) {
	output := os.Getenv("STRIDE_990_CLIENT_SERVER")
	if output == "" {
		t.Skip("explicit local client server output required")
	}
	dsn := os.Getenv("STRIDE_WORKER_TEST_MYSQL_DSN")
	cfg, err := mysql.ParseDSN(dsn)
	if err != nil || cfg.User != "root" || cfg.Net != "tcp" || cfg.Addr != "127.0.0.1:13383" || cfg.DBName != "stride_983_test" {
		t.Fatal("requires dedicated root-owned localhost stride_983_test database")
	}
	st, err := storage.Open(dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	ctx := context.Background()
	for _, migrate := range []func(context.Context) error{st.AutoMigrate, st.AutoMigrateWatch, st.AutoMigrateUsers, st.AutoMigrateGoals, st.AutoMigrateMasterPlan, st.AutoMigrateWeeklyPlan, st.AutoMigrateWeeklyFeedback, st.AutoMigrateBodyComposition, st.AutoMigrateTeamLikes, st.AutoMigrateScheduledWorkout, st.AutoMigrateRaceFavorites, st.AutoMigrateRacePlans, st.AutoMigrateRaceStrategies, st.AutoMigrateUserCustomRaces, st.AutoMigrateHomeCity, st.AutoMigratePlanAdjustment, st.AutoMigratePlanInjury, st.AutoMigrateWorkout, st.AutoMigrateFeedback, st.AutoMigrateRoadmap, st.AutoMigrateProviderEvents, st.AutoMigrateCheckIn, st.AutoMigratePoints, st.AutoMigrateAddresses} {
		if err := migrate(ctx); err != nil {
			t.Fatal(err)
		}
	}
	blobs, err := tsstore.NewFileStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	st.SetTSBlobStore(blobs)
	original, err := st.CalibrationPolicy(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		current, e := st.CalibrationPolicy(ctx)
		if e == nil {
			_, e = st.ReplaceCalibrationPolicy(ctx, current.Revision, original)
		}
		if e != nil {
			t.Errorf("restore policy: %v", e)
		}
	}()
	p := original
	p.ActiveVersion = 4
	if _, err = st.ReplaceCalibrationPolicy(ctx, p.Revision, p); err != nil {
		t.Fatal(err)
	}
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	gin.SetMode(gin.TestMode)
	verifier := NewJWTVerifierFromKey(&key.PublicKey, "stride-local-t7", "stride-local-client")
	svc := NewService(Config{Auth: NewAuthenticator("", verifier), StrideStore: st, HealthStore: st, ActivityStore: st, UserStore: st})
	listener, err := net.Listen("tcp", "127.0.0.1:19890")
	if err != nil {
		t.Fatal(err)
	}
	router := svc.Router()
	// Local identity assembly only: production /users/me belongs to auth-service.
	// It reads the persisted synthetic profile after real signature verification.
	router.GET("/api/users/me", func(c *gin.Context) {
		token, ok := strings.CutPrefix(c.GetHeader("Authorization"), "Bearer ")
		if !ok {
			c.AbortWithStatus(http.StatusUnauthorized)
			return
		}
		caller, err := verifier.Verify(token)
		if err != nil {
			c.AbortWithStatus(http.StatusUnauthorized)
			return
		}
		profile, err := st.GetUserProfile(c.Request.Context(), caller.UserID)
		if err != nil {
			c.AbortWithStatus(http.StatusInternalServerError)
			return
		}
		if profile == nil {
			c.AbortWithStatus(http.StatusNotFound)
			return
		}
		c.JSON(http.StatusOK, gin.H{"id": caller.UserID, "display_name": profile.DisplayName})
	})
	server := &http.Server{Handler: router, ReadHeaderTimeout: 5 * time.Second}
	defer server.Shutdown(ctx)
	go func() { _ = server.Serve(listener) }()
	var fixture struct {
		Cases []struct {
			Name     string `json:"name"`
			Response struct {
				Threshold *strideThresholdDTO `json:"threshold"`
			} `json:"response"`
			Expected       json.RawMessage `json:"expected"`
			ServerExpected json.RawMessage `json:"server_expected"`
		} `json:"cases"`
	}
	raw, err := os.ReadFile("../../../../docs/calibration/fixtures/client-display-v1.json")
	if err != nil {
		t.Fatal(err)
	}
	if err = json.Unmarshal(raw, &fixture); err != nil {
		t.Fatal(err)
	}
	type clientCase struct {
		Name     string          `json:"name"`
		UserID   string          `json:"user_id"`
		Token    string          `json:"token"`
		Response json.RawMessage `json:"response"`
		Hash     string          `json:"sha256"`
		Expected json.RawMessage `json:"expected"`
	}
	var cases []clientCase
	for _, c := range fixture.Cases {
		user := uuid.NewString()
		defer func() {
			if e := st.DeleteUserData(ctx, user); e != nil {
				t.Errorf("cleanup: %v", e)
			}
		}()
		if err = st.UpsertUserProfile(ctx, &storage.UserProfile{UserID: user, DisplayName: "T7 Synthetic"}); err != nil {
			t.Fatal(err)
		}
		if err = st.SetProfileReady(ctx, user); err != nil {
			t.Fatal(err)
		}
		if _, err = st.FinalizeOnboardingRun(ctx, user); err != nil {
			t.Fatal(err)
		}
		if c.Response.Threshold != nil {
			th := c.Response.Threshold
			sourceJSON, _ := json.Marshal(th.Source)
			if strings.HasPrefix(c.Name, "producer-") {
				snapshot, producedSource := clientProducerSource(t, c.Name == "producer-lab-half")
				if c.Name == "producer-stale-hr" {
					result := clientProducerResult(t, false, time.Date(2026, 11, 14, 0, 0, 0, 0, time.UTC), time.Date(2026, 9, 14, 0, 0, 0, 0, time.UTC))
					snapshot, producedSource = result.Snapshot, calibration.SummarizeSource(result)
				}
				th.SpeedMps, th.HRBpm = snapshot.ThresholdSpeedMps, snapshot.ThresholdHR
				th.SpeedConfidence, th.HRConfidence = string(snapshot.ThresholdSpeedConfidence), string(snapshot.ThresholdHRConfidence)
				sourceJSON, err = json.Marshal(producedSource)
				if err != nil {
					t.Fatal(err)
				}
			}
			source := string(sourceJSON)
			if c.Name == "legacy" {
				source = ""
			}
			if c.Name == "source-unavailable" {
				source = "{"
			}
			if c.Name == "upper-only" {
				var v map[string]any
				_ = json.Unmarshal(sourceJSON, &v)
				speed := v["speed"].(map[string]any)
				speed["range_low"] = nil
				speed["range_high"] = 4
				vraw, _ := json.Marshal(v)
				source = string(vraw)
			}
			version := 4
			if c.Name == "legacy" {
				version = 3
			}
			computed, _ := time.Parse(time.RFC3339, "2026-11-14T16:30:00Z")
			if _, err = st.PublishRunningCalibration(ctx, &storage.RunningCalibrationSnapshot{UserID: user, AsOfDate: th.AsOfDate, AlgorithmVersion: version, ThresholdSpeedMps: th.SpeedMps, ThresholdHR: th.HRBpm, ThresholdSpeedConfidence: th.SpeedConfidence, ThresholdHRConfidence: th.HRConfidence, ComputedAt: computed, SourceJSON: &source}, nil, nil); err != nil {
				t.Fatal(err)
			}
		}
		token, err := jwt.NewWithClaims(jwt.SigningMethodRS256, jwt.MapClaims{"sub": user, "iss": "stride-local-t7", "aud": "stride-local-client", "exp": time.Now().Add(3 * time.Hour).Unix()}).SignedString(key)
		if err != nil {
			t.Fatal(err)
		}
		req, _ := http.NewRequest("GET", "http://127.0.0.1:19890/api/"+user+"/stride/zones", nil)
		req.Header.Set("Authorization", "Bearer "+token)
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		var body json.RawMessage
		err = json.NewDecoder(res.Body).Decode(&body)
		res.Body.Close()
		if err != nil || res.StatusCode != 200 {
			t.Fatal("fixture HTTP read failed")
		}
		digest := sha256.Sum256(body)
		expected := c.Expected
		if len(c.ServerExpected) > 0 {
			expected = c.ServerExpected
		}
		cases = append(cases, clientCase{c.Name, user, token, body, hex.EncodeToString(digest[:]), expected})
	}
	payload, _ := json.MarshalIndent(struct {
		URL   string       `json:"url"`
		Cases []clientCase `json:"cases"`
	}{"http://127.0.0.1:19890", cases}, "", "  ")
	if err = os.MkdirAll(filepath.Dir(output), 0700); err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(output, payload, 0600); err != nil {
		t.Fatal(err)
	}
	t.Log("real local GIN/MySQL/JWT client service ready; private manifest written")
	deadline := time.NewTimer(3 * time.Hour)
	defer deadline.Stop()
	tick := time.NewTicker(time.Second)
	defer tick.Stop()
	for {
		select {
		case <-deadline.C:
			t.Fatal("client server completion timed out")
		case <-tick.C:
			if _, e := os.Stat(output + ".done"); e == nil {
				return
			}
		}
	}
}
