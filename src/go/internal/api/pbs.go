// pbs.go is the personal-best read surface: a sibling registrar that shadows
// the FastAPI route in stride_server/routes/pbs.py
//
//   - GET /api/{user}/pbs          (best-effort PBs for 1K/3K/5K/10K/HM/FM)
//
// It reads the persisted personal_bests table (populated post-sync) instead of
// recomputing the ~7s best-effort scan per request, emits the cached entry_json
// (history progression + segment offsets) in the canonical DISTANCE_ORDER, and
// reuses the two auth tiers. The PB detector itself is internal/compute/pb; this
// route is a thin read-through of the storage table.
package api

import (
	"context"
	"encoding/json"
	"net/http"
	"sort"
	"time"

	"github.com/gin-gonic/gin"
	"go.uber.org/zap"

	"github.com/zhaochy1990/stride/internal/compute/pb"
	"github.com/zhaochy1990/stride/internal/logging"
	"github.com/zhaochy1990/stride/internal/storage"
)

// ─────────────────────────────────────────────────────────────────────────────
// Dependency. A narrow read port so the api package stays free of GORM.
// Satisfied by *storage.Store.
// ─────────────────────────────────────────────────────────────────────────────

// PBStore is the read surface the pbs endpoint needs.
type PBStore interface {
	PersonalBests(ctx context.Context, userID string) ([]storage.PersonalBest, error)
}

// ─────────────────────────────────────────────────────────────────────────────
// Registrar
// ─────────────────────────────────────────────────────────────────────────────

type pbsRoutes struct {
	store PBStore
	log   *zap.Logger
}

func newPbsRoutes(store PBStore, log *zap.Logger) *pbsRoutes {
	if log == nil {
		log = logging.Default()
	}
	return &pbsRoutes{store: store, log: log}
}

func (p *pbsRoutes) register(rg *gin.RouterGroup) {
	rg.GET("/api/:user/pbs", p.get)
}

// ─────────────────────────────────────────────────────────────────────────────
// Ordering — mirrors stride_core.pb_records.DISTANCE_ORDER.
// ─────────────────────────────────────────────────────────────────────────────

var pbDistanceOrder = []string{"1K", "3K", "5K", "10K", "HM", "FM"}

var pbDistanceRank = func() map[string]int {
	m := make(map[string]int, len(pbDistanceOrder))
	for i, d := range pbDistanceOrder {
		m[d] = i
	}
	return m
}()

// ─────────────────────────────────────────────────────────────────────────────
// DTOs — mirror pbs.PBEntry / PBsResponse. History is passed through as raw
// maps (entry_json already serialises the best-so-far progression) so the wire
// JSON keys are byte-identical to the Python producer.
// ─────────────────────────────────────────────────────────────────────────────

type pbEntryDTO struct {
	Distance      string           `json:"distance"`
	RaceType      string           `json:"race_type"`
	PBTimeSec     float64          `json:"pb_time_sec"`
	AchievedAt    string           `json:"achieved_at"`
	LabelID       string           `json:"label_id"`
	Source        string           `json:"source"`
	Name          *string          `json:"name"`
	SegmentStartS *float64         `json:"segment_start_s,omitempty"`
	SegmentEndS   *float64         `json:"segment_end_s,omitempty"`
	History       []map[string]any `json:"history"`
}

type pbsResponse struct {
	UserID     string       `json:"user_id"`
	ComputedAt string       `json:"computed_at"`
	PBs        []pbEntryDTO `json:"pbs"`
}

// ─────────────────────────────────────────────────────────────────────────────
// Handler
// ─────────────────────────────────────────────────────────────────────────────

// get returns the user's cached personal bests, ordered 1K→FM.
//
//	@Summary		Personal bests
//	@Description	Returns the best-effort personal bests for 1K, 3K, 5K, 10K, HM and FM, read from the persisted personal_bests table (populated post-sync). Only distances present are returned, in canonical order. A user caller may only read their own data; an internal caller may read any user.
//	@Tags			metrics
//	@Produce		json
//	@Param			user	path		string	true	"User id (JWT sub)"
//	@Success		200		{object}	pbsResponse
//	@Failure		401		{object}	errorResponse
//	@Failure		403		{object}	errorResponse
//	@Failure		500		{object}	errorResponse
//	@Security		InternalToken
//	@Security		BearerAuth
//	@Router			/api/{user}/pbs [get]
func (p *pbsRoutes) get(c *gin.Context) {
	user := c.Param("user")
	if !authorizeUser(c, user) {
		return
	}
	ctx := c.Request.Context()

	rows, err := p.store.PersonalBests(ctx, user)
	if err != nil {
		p.log.Error("pbs: read failed", zapErr(err))
		c.JSON(http.StatusInternalServerError, errorResponse{Error: "internal error"})
		return
	}

	// Order by canonical distance (storage returns distance-alphabetical, e.g.
	// HM/FM after 1K..10K would be wrong). Mirrors the Python route iterating
	// _DISTANCE_ORDER.
	sort.Slice(rows, func(i, j int) bool {
		return pbDistanceRank[rows[i].Distance] < pbDistanceRank[rows[j].Distance]
	})

	pbs := make([]pbEntryDTO, 0, len(rows))
	for _, row := range rows {
		var entry pb.Entry
		if err := json.Unmarshal([]byte(row.EntryJSON), &entry); err != nil {
			p.log.Error("pbs: entry_json parse failed", zapErr(err))
			c.JSON(http.StatusInternalServerError, errorResponse{Error: "internal error"})
			return
		}
		pbs = append(pbs, pbEntryDTO{
			Distance:      entry.Distance,
			RaceType:      entry.RaceType,
			PBTimeSec:     entry.PBTimeSec,
			AchievedAt:    entry.AchievedAt,
			LabelID:       entry.LabelID,
			Source:        entry.Source,
			Name:          entry.Name,
			SegmentStartS: entry.SegmentStartS,
			SegmentEndS:   entry.SegmentEndS,
			History:       entry.History,
		})
	}

	c.JSON(http.StatusOK, pbsResponse{
		UserID:     user,
		ComputedAt: time.Now().UTC().Format(time.RFC3339),
		PBs:        pbs,
	})
}
