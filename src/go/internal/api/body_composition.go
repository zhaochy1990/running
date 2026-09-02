// body_composition.go is the body-composition scan read/write surface — a
// sibling registrar shadowing the FastAPI routes in
// stride_server/routes/body_composition.py:
//
//   - GET  /api/{user}/body-composition           (list scans, newest-first)
//   - GET  /api/{user}/body-composition/summary   (latest + deltas + checkpoints)
//   - GET  /api/{user}/body-composition/{scanDate}(single scan + 5 segments)
//   - POST /api/{user}/body-composition           (upsert by scan_date)
//
// Response shapes match the Python contract exactly so the BFF strangler
// seam can flip each route independently. Derived fields (left/right deltas,
// upper/lower ratio, per-segment flat fields) are computed in this layer —
// same as the Python _derive() helper.
//
// Phase checkpoints are hardcoded season targets (same as the Python
// PHASE_CHECKPOINTS constant) — not yet user-configurable.
package api

import (
	"context"
	"errors"
	"math"
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"
	"go.uber.org/zap"
	"gorm.io/gorm"

	"github.com/zhaochy1990/stride/internal/logging"
	"github.com/zhaochy1990/stride/internal/storage"
)

// PhaseCheckpoint mirrors the Python PHASE_CHECKPOINTS constant — hardcoded
// 2026 season targets for weight, body fat, and minimum skeletal muscle mass.
type PhaseCheckpoint struct {
	Phase     string  `json:"phase"`
	Date      string  `json:"date"`
	WeightKg  float64 `json:"weight_kg"`
	BodyFatPct float64 `json:"body_fat_pct"`
	SmmKgMin  float64 `json:"smm_kg_min"`
}

// seasonPhaseCheckpoints are the 2026 race-prep body composition targets.
// Kept in the API layer (not storage) because they're presentation metadata,
// not persisted user data.
var seasonPhaseCheckpoints = []PhaseCheckpoint{
	{Phase: "Phase 1", Date: "2026-06-21", WeightKg: 70.5, BodyFatPct: 21.0, SmmKgMin: 31.0},
	{Phase: "Phase 2", Date: "2026-08-16", WeightKg: 69.0, BodyFatPct: 19.0, SmmKgMin: 30.8},
	{Phase: "Phase 3", Date: "2026-10-25", WeightKg: 68.0, BodyFatPct: 17.5, SmmKgMin: 30.5},
}

// ─── Dependency port ────────────────────────────────────────────────────────

// BodyCompositionStore is the read+write surface the body-composition
// endpoints need. Defined here (not in storage) so the api package stays
// GORM-free.
type BodyCompositionStore interface {
	ListBodyCompositionScans(ctx context.Context, userID string, days int) ([]storage.BodyCompositionScanRecord, error)
	GetBodyCompositionScan(ctx context.Context, userID, scanDate string) (*storage.BodyCompositionScanRecord, error)
	LatestBodyCompositionScan(ctx context.Context, userID string) (*storage.BodyCompositionScanRecord, error)
	PreviousBodyCompositionScan(ctx context.Context, userID, beforeDate string) (*storage.BodyCompositionScanRecord, error)
	UpsertBodyCompositionScan(ctx context.Context, userID string, input *storage.BodyCompositionScanRecord) (*storage.BodyCompositionScanRecord, error)
	HasBodyComposition(ctx context.Context, userID string) (bool, error)
}

// ─── Registrar ──────────────────────────────────────────────────────────────

type bodyCompositionRoutes struct {
	store BodyCompositionStore
	log   *zap.Logger
}

func newBodyCompositionRoutes(store BodyCompositionStore, log *zap.Logger) *bodyCompositionRoutes {
	if log == nil {
		log = logging.Default()
	}
	return &bodyCompositionRoutes{store: store, log: log}
}

func (b *bodyCompositionRoutes) register(rg *gin.RouterGroup) {
	rg.GET("/api/:user/body-composition/summary", b.summary)
	rg.GET("/api/:user/body-composition/:scan_date", b.getScan)
	rg.GET("/api/:user/body-composition", b.list)
	rg.POST("/api/:user/body-composition", b.upsert)
}

// ─── DTOs ───────────────────────────────────────────────────────────────────

type bodyCompositionSegmentDTO struct {
	Segment           string   `json:"segment"`
	LeanMassKg        float64  `json:"lean_mass_kg"`
	FatMassKg         float64  `json:"fat_mass_kg"`
	LeanPctOfStandard *float64 `json:"lean_pct_of_standard"`
	FatPctOfStandard  *float64 `json:"fat_pct_of_standard"`
}

type bodyCompositionScanDTO struct {
	ScanDate         string   `json:"scan_date"`
	JpgPath          *string  `json:"jpg_path"`
	WeightKg         float64  `json:"weight_kg"`
	BodyFatPct       float64  `json:"body_fat_pct"`
	SmmKg            float64  `json:"smm_kg"`
	FatMassKg        float64  `json:"fat_mass_kg"`
	VisceralFatLevel int      `json:"visceral_fat_level"`
	BmrKcal          *int     `json:"bmr_kcal"`
	ProteinKg        *float64 `json:"protein_kg"`
	WaterL           *float64 `json:"water_l"`
	Smi              *float64 `json:"smi"`
	InbodyScore      *int     `json:"inbody_score"`
	IngestedAt       string   `json:"ingested_at"`
	// Derived — deltas / ratios
	LegSmmDelta       *float64 `json:"leg_smm_delta"`
	LegFatDelta       *float64 `json:"leg_fat_delta"`
	ArmSmmDelta       *float64 `json:"arm_smm_delta"`
	UpperLowerSmmRatio *float64 `json:"upper_lower_smm_ratio"`
	// Derived — per-segment flat fields (for easy chart access)
	LeftArmSmmKg      *float64 `json:"left_arm_smm_kg"`
	RightArmSmmKg     *float64 `json:"right_arm_smm_kg"`
	TrunkSmmKg        *float64 `json:"trunk_smm_kg"`
	LeftLegSmmKg      *float64 `json:"left_leg_smm_kg"`
	RightLegSmmKg     *float64 `json:"right_leg_smm_kg"`
	LeftArmFatKg      *float64 `json:"left_arm_fat_kg"`
	RightArmFatKg     *float64 `json:"right_arm_fat_kg"`
	TrunkFatKg        *float64 `json:"trunk_fat_kg"`
	LeftLegFatKg      *float64 `json:"left_leg_fat_kg"`
	RightLegFatKg     *float64 `json:"right_leg_fat_kg"`
	LeftArmLeanPctStd *float64 `json:"left_arm_lean_pct_std"`
	RightArmLeanPctStd *float64 `json:"right_arm_lean_pct_std"`
	TrunkLeanPctStd   *float64 `json:"trunk_lean_pct_std"`
	LeftLegLeanPctStd *float64 `json:"left_leg_lean_pct_std"`
	RightLegLeanPctStd *float64 `json:"right_leg_lean_pct_std"`
	LeftArmFatPctStd  *float64 `json:"left_arm_fat_pct_std"`
	RightArmFatPctStd *float64 `json:"right_arm_fat_pct_std"`
	TrunkFatPctStd    *float64 `json:"trunk_fat_pct_std"`
	LeftLegFatPctStd  *float64 `json:"left_leg_fat_pct_std"`
	RightLegFatPctStd *float64 `json:"right_leg_fat_pct_std"`
	// Segments array (repeated data, matches Python contract)
	Segments []bodyCompositionSegmentDTO `json:"segments"`
}

type bodyCompositionListResponse struct {
	Scans []bodyCompositionScanDTO `json:"scans"`
}

type bodyCompositionDeltasDTO struct {
	PrevDate         string  `json:"prev_date"`
	WeightKg         float64 `json:"weight_kg"`
	BodyFatPct       float64 `json:"body_fat_pct"`
	SmmKg            float64 `json:"smm_kg"`
	FatMassKg        float64 `json:"fat_mass_kg"`
	VisceralFatLevel int     `json:"visceral_fat_level"`
}

type bodyCompositionSummaryResponse struct {
	Latest      *bodyCompositionScanDTO  `json:"latest"`
	Deltas      *bodyCompositionDeltasDTO `json:"deltas"`
	Checkpoints []PhaseCheckpoint        `json:"checkpoints"`
}

type bodyCompositionScanInput struct {
	ScanDate         string                        `json:"scan_date" binding:"required"`
	WeightKg         float64                       `json:"weight_kg" binding:"required"`
	BodyFatPct       float64                       `json:"body_fat_pct" binding:"required"`
	SmmKg            float64                       `json:"smm_kg" binding:"required"`
	FatMassKg        float64                       `json:"fat_mass_kg" binding:"required"`
	VisceralFatLevel int                           `json:"visceral_fat_level" binding:"required"`
	JpgPath          *string                       `json:"jpg_path"`
	BmrKcal          *int                          `json:"bmr_kcal"`
	ProteinKg        *float64                      `json:"protein_kg"`
	WaterL           *float64                      `json:"water_l"`
	Smi              *float64                      `json:"smi"`
	InbodyScore      *int                          `json:"inbody_score"`
	Segments         []bodyCompositionSegmentInput `json:"segments"`
}

type bodyCompositionSegmentInput struct {
	Segment           string   `json:"segment" binding:"required"`
	LeanMassKg        float64  `json:"lean_mass_kg" binding:"required"`
	FatMassKg         float64  `json:"fat_mass_kg" binding:"required"`
	LeanPctOfStandard *float64 `json:"lean_pct_of_standard"`
	FatPctOfStandard  *float64 `json:"fat_pct_of_standard"`
}

// ─── Derivation ─────────────────────────────────────────────────────────────

// toScanDTO maps a storage record + its segments to the front-end DTO,
// attaching all derived fields. Equivalent to Python's _derive() + _segments_by_name().
func toScanDTO(scan *storage.BodyCompositionScanRecord) bodyCompositionScanDTO {
	segs := segmentsByName(scan.Segments)

	dto := bodyCompositionScanDTO{
		ScanDate:         scan.ScanDate,
		JpgPath:          scan.JpgPath,
		WeightKg:         scan.WeightKg,
		BodyFatPct:       scan.BodyFatPct,
		SmmKg:            scan.SmmKg,
		FatMassKg:        scan.FatMassKg,
		VisceralFatLevel: scan.VisceralFatLevel,
		BmrKcal:          scan.BmrKcal,
		ProteinKg:        scan.ProteinKg,
		WaterL:           scan.WaterL,
		Smi:              scan.Smi,
		InbodyScore:      scan.InbodyScore,
		IngestedAt:       scan.IngestedAt.UTC().Format(timeFormat),
	}

	// Segments array
	segList := make([]bodyCompositionSegmentDTO, 0, len(scan.Segments))
	for _, s := range scan.Segments {
		segList = append(segList, bodyCompositionSegmentDTO{
			Segment:           s.Segment,
			LeanMassKg:        s.LeanMassKg,
			FatMassKg:         s.FatMassKg,
			LeanPctOfStandard: s.LeanPctOfStandard,
			FatPctOfStandard:  s.FatPctOfStandard,
		})
	}
	dto.Segments = segList

	// Derived: deltas
	ll := segs[storage.SegLeftLeg]
	rl := segs[storage.SegRightLeg]
	la := segs[storage.SegLeftArm]
	ra := segs[storage.SegRightArm]
	tr := segs[storage.SegTrunk]

	if ll != nil && rl != nil {
		v := round2(rl.LeanMassKg - ll.LeanMassKg)
		dto.LegSmmDelta = &v
		vf := round2(rl.FatMassKg - ll.FatMassKg)
		dto.LegFatDelta = &vf
	}
	if la != nil && ra != nil {
		v := round2(ra.LeanMassKg - la.LeanMassKg)
		dto.ArmSmmDelta = &v
	}

	// Derived: upper/lower ratio
	if la != nil && ra != nil && tr != nil && ll != nil && rl != nil {
		upper := la.LeanMassKg + ra.LeanMassKg + tr.LeanMassKg
		lower := ll.LeanMassKg + rl.LeanMassKg
		if lower > 0 {
			v := round3(upper / lower)
			dto.UpperLowerSmmRatio = &v
		}
	}

	// Derived: per-segment flat fields
	setSegFields := func(name string, seg *storage.BodyCompositionSegmentRecord) {
		if seg == nil {
			return
		}
		smm := seg.LeanMassKg
		fat := seg.FatMassKg
		switch name {
		case storage.SegLeftArm:
			dto.LeftArmSmmKg = &smm
			dto.LeftArmFatKg = &fat
			dto.LeftArmLeanPctStd = seg.LeanPctOfStandard
			dto.LeftArmFatPctStd = seg.FatPctOfStandard
		case storage.SegRightArm:
			dto.RightArmSmmKg = &smm
			dto.RightArmFatKg = &fat
			dto.RightArmLeanPctStd = seg.LeanPctOfStandard
			dto.RightArmFatPctStd = seg.FatPctOfStandard
		case storage.SegTrunk:
			dto.TrunkSmmKg = &smm
			dto.TrunkFatKg = &fat
			dto.TrunkLeanPctStd = seg.LeanPctOfStandard
			dto.TrunkFatPctStd = seg.FatPctOfStandard
		case storage.SegLeftLeg:
			dto.LeftLegSmmKg = &smm
			dto.LeftLegFatKg = &fat
			dto.LeftLegLeanPctStd = seg.LeanPctOfStandard
			dto.LeftLegFatPctStd = seg.FatPctOfStandard
		case storage.SegRightLeg:
			dto.RightLegSmmKg = &smm
			dto.RightLegFatKg = &fat
			dto.RightLegLeanPctStd = seg.LeanPctOfStandard
			dto.RightLegFatPctStd = seg.FatPctOfStandard
		}
	}
	setSegFields(storage.SegLeftArm, la)
	setSegFields(storage.SegRightArm, ra)
	setSegFields(storage.SegTrunk, tr)
	setSegFields(storage.SegLeftLeg, ll)
	setSegFields(storage.SegRightLeg, rl)

	return dto
}

func segmentsByName(segs []storage.BodyCompositionSegmentRecord) map[string]*storage.BodyCompositionSegmentRecord {
	out := make(map[string]*storage.BodyCompositionSegmentRecord, len(segs))
	for i := range segs {
		out[segs[i].Segment] = &segs[i]
	}
	return out
}

func round2(v float64) float64 {
	return math.Round(v*100) / 100
}

func round3(v float64) float64 {
	return math.Round(v*1000) / 1000
}

// ─── Handlers ───────────────────────────────────────────────────────────────

// list godoc
//
//	@Summary		List body-composition scans
//	@Description	Returns scans newest-first, each with derived fields and per-segment breakdown. A user caller may only read their own data; an internal caller may read any user.
//	@Tags			body-composition
//	@Produce		json
//	@Param			user	path		string	true	"User id (JWT sub)"
//	@Param			days	query		int		false	"Only return scans from the most recent N days (1-3650)"
//	@Success		200	{object}	bodyCompositionListResponse
//	@Failure		401	{object}	errorResponse
//	@Failure		403	{object}	errorResponse
//	@Failure		422	{object}	errorResponse
//	@Security		BearerAuth
//	@Router			/api/{user}/body-composition [get]
func (b *bodyCompositionRoutes) list(c *gin.Context) {
	user := c.Param("user")
	if !authorizeUser(c, user) {
		return
	}

	days := 0
	if raw := c.Query("days"); raw != "" {
		n, err := strconv.Atoi(raw)
		if err != nil || n < 1 || n > 3650 {
			c.JSON(http.StatusUnprocessableEntity, validationErrorResponse{
				Detail: []validationDetailItem{{Loc: []string{"query", "days"}, Msg: "must be an integer between 1 and 3650"}},
			})
			return
		}
		days = n
	}

	scans, err := b.store.ListBodyCompositionScans(c.Request.Context(), user, days)
	if err != nil {
		b.log.Error("list body composition scans", zap.Error(err))
		c.JSON(http.StatusInternalServerError, errorResponse{Error: "internal error"})
		return
	}
	out := make([]bodyCompositionScanDTO, len(scans))
	for i := range scans {
		out[i] = toScanDTO(&scans[i])
	}
	c.JSON(http.StatusOK, bodyCompositionListResponse{Scans: out})
}

// summary godoc
//
//	@Summary		Body-composition summary
//	@Description	Returns the latest scan, deltas from the previous scan, and the season phase checkpoints. A user caller may only read their own data; an internal caller may read any user.
//	@Tags			body-composition
//	@Produce		json
//	@Param			user	path		string	true	"User id (JWT sub)"
//	@Success		200	{object}	bodyCompositionSummaryResponse
//	@Failure		401	{object}	errorResponse
//	@Failure		403	{object}	errorResponse
//	@Security		BearerAuth
//	@Router			/api/{user}/body-composition/summary [get]
func (b *bodyCompositionRoutes) summary(c *gin.Context) {
	user := c.Param("user")
	if !authorizeUser(c, user) {
		return
	}

	latest, err := b.store.LatestBodyCompositionScan(c.Request.Context(), user)
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			c.JSON(http.StatusOK, bodyCompositionSummaryResponse{
				Latest:      nil,
				Deltas:      nil,
				Checkpoints: seasonPhaseCheckpoints,
			})
			return
		}
		b.log.Error("latest body composition scan", zap.Error(err))
		c.JSON(http.StatusInternalServerError, errorResponse{Error: "internal error"})
		return
	}

	latestDTO := toScanDTO(latest)

	var deltas *bodyCompositionDeltasDTO
	prev, err := b.store.PreviousBodyCompositionScan(c.Request.Context(), user, latest.ScanDate)
	if err == nil && prev != nil {
		deltas = &bodyCompositionDeltasDTO{
			PrevDate:         prev.ScanDate,
			WeightKg:         round2(latest.WeightKg - prev.WeightKg),
			BodyFatPct:       round2(latest.BodyFatPct - prev.BodyFatPct),
			SmmKg:            round2(latest.SmmKg - prev.SmmKg),
			FatMassKg:        round2(latest.FatMassKg - prev.FatMassKg),
			VisceralFatLevel: latest.VisceralFatLevel - prev.VisceralFatLevel,
		}
	}

	c.JSON(http.StatusOK, bodyCompositionSummaryResponse{
		Latest:      &latestDTO,
		Deltas:      deltas,
		Checkpoints: seasonPhaseCheckpoints,
	})
}

// getScan godoc
//
//	@Summary		Get a single body-composition scan
//	@Description	Returns one scan by date with its five-segment breakdown and derived fields. A user caller may only read their own data; an internal caller may read any user.
//	@Tags			body-composition
//	@Produce		json
//	@Param			user		path		string	true	"User id (JWT sub)"
//	@Param			scan_date	path		string	true	"Scan date (YYYY-MM-DD)"
//	@Success		200	{object}	bodyCompositionScanDTO
//	@Failure		401	{object}	errorResponse
//	@Failure		403	{object}	errorResponse
//	@Failure		404	{object}	errorResponse
//	@Security		BearerAuth
//	@Router			/api/{user}/body-composition/{scan_date} [get]
func (b *bodyCompositionRoutes) getScan(c *gin.Context) {
	user := c.Param("user")
	if !authorizeUser(c, user) {
		return
	}
	scanDate := c.Param("scan_date")

	scan, err := b.store.GetBodyCompositionScan(c.Request.Context(), user, scanDate)
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			c.JSON(http.StatusNotFound, errorResponse{Error: "scan not found"})
			return
		}
		b.log.Error("get body composition scan", zap.Error(err))
		c.JSON(http.StatusInternalServerError, errorResponse{Error: "internal error"})
		return
	}
	dto := toScanDTO(scan)
	c.JSON(http.StatusOK, dto)
}

// upsert godoc
//
//	@Summary		Upsert a body-composition scan
//	@Description	Creates or replaces a scan keyed by (user, scan_date). When segments are provided, all existing segments for the scan are replaced atomically. A user caller may only write their own data; an internal caller may write any user.
//	@Tags			body-composition
//	@Accept			json
//	@Produce		json
//	@Param			user	path		string						true	"User id (JWT sub)"
//	@Param			body	body		bodyCompositionScanInput	true	"Scan data"
//	@Success		200		{object}	bodyCompositionScanDTO
//	@Failure		401		{object}	errorResponse
//	@Failure		403		{object}	errorResponse
//	@Failure		422		{object}	errorResponse
//	@Security		BearerAuth
//	@Router			/api/{user}/body-composition [post]
func (b *bodyCompositionRoutes) upsert(c *gin.Context) {
	user := c.Param("user")
	if !authorizeUser(c, user) {
		return
	}

	var in bodyCompositionScanInput
	if err := c.ShouldBindJSON(&in); err != nil {
		c.JSON(http.StatusUnprocessableEntity, validationErrorResponse{Detail: bindingDetail(err)})
		return
	}

	// Build storage record from input
	scan := &storage.BodyCompositionScanRecord{
		ScanDate:         in.ScanDate,
		WeightKg:         in.WeightKg,
		BodyFatPct:       in.BodyFatPct,
		SmmKg:            in.SmmKg,
		FatMassKg:        in.FatMassKg,
		VisceralFatLevel: in.VisceralFatLevel,
		JpgPath:          in.JpgPath,
		BmrKcal:          in.BmrKcal,
		ProteinKg:        in.ProteinKg,
		WaterL:           in.WaterL,
		Smi:              in.Smi,
		InbodyScore:      in.InbodyScore,
	}
	for _, s := range in.Segments {
		scan.Segments = append(scan.Segments, storage.BodyCompositionSegmentRecord{
			Segment:           s.Segment,
			LeanMassKg:        s.LeanMassKg,
			FatMassKg:         s.FatMassKg,
			LeanPctOfStandard: s.LeanPctOfStandard,
			FatPctOfStandard:  s.FatPctOfStandard,
		})
	}

	result, err := b.store.UpsertBodyCompositionScan(c.Request.Context(), user, scan)
	if err != nil {
		var valErr *storage.BodyCompositionValidationError
		if errors.As(err, &valErr) {
			c.JSON(http.StatusUnprocessableEntity, errorResponse{Error: valErr.Message})
			return
		}
		b.log.Error("upsert body composition scan", zap.Error(err))
		c.JSON(http.StatusInternalServerError, errorResponse{Error: "internal error"})
		return
	}

	dto := toScanDTO(result)
	c.JSON(http.StatusOK, dto)
}

