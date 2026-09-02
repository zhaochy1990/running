package storage

import "time"

// BodyCompositionScanRecord is a user-owned body-composition scan snapshot.
// The composite unique key (user_id, scan_date) mirrors the Python SQLite
// primary key scan_date, with user_id added as the multi-tenant boundary.
// Scan_date is a Shanghai-local calendar-day string (YYYY-MM-DD), not a UTC
// instant — stored as varchar so ordering is bytewise-lexicographic and
// timezone-free, matching the Python contract.
type BodyCompositionScanRecord struct {
	ID               string     `gorm:"column:id;type:char(36);primaryKey"`
	UserID           string     `gorm:"column:user_id;type:char(36);not null;uniqueIndex:uq_user_scan_date,priority:1;index:idx_user_scan_date_desc,priority:1"`
	ScanDate         string     `gorm:"column:scan_date;type:varchar(16);not null;uniqueIndex:uq_user_scan_date,priority:2;index:idx_user_scan_date_desc,priority:2,sort:desc"`
	WeightKg         float64    `gorm:"column:weight_kg;type:double;not null"`
	BodyFatPct       float64    `gorm:"column:body_fat_pct;type:double;not null"`
	SmmKg            float64    `gorm:"column:smm_kg;type:double;not null"`
	FatMassKg        float64    `gorm:"column:fat_mass_kg;type:double;not null"`
	VisceralFatLevel int        `gorm:"column:visceral_fat_level;type:int;not null"`
	JpgPath          *string    `gorm:"column:jpg_path;type:varchar(512)"`
	BmrKcal          *int       `gorm:"column:bmr_kcal;type:int"`
	ProteinKg        *float64   `gorm:"column:protein_kg;type:double"`
	WaterL           *float64   `gorm:"column:water_l;type:double"`
	Smi              *float64   `gorm:"column:smi;type:double"`
	InbodyScore      *int       `gorm:"column:inbody_score;type:int"`
	IngestedAt       time.Time  `gorm:"column:ingested_at;type:datetime(6);autoCreateTime:false"`
	Segments         []BodyCompositionSegmentRecord `gorm:"foreignKey:ScanID;references:ID"`
}

func (BodyCompositionScanRecord) TableName() string { return "user_body_composition_scan" }

// BodyCompositionSegmentRecord is one of five body segments for a scan.
// Segments are one of: left_arm, right_arm, trunk, left_leg, right_leg.
type BodyCompositionSegmentRecord struct {
	ID                string   `gorm:"column:id;type:char(36);primaryKey"`
	ScanID            string   `gorm:"column:scan_id;type:char(36);not null;uniqueIndex:uq_scan_segment,priority:1;index"`
	Segment           string   `gorm:"column:segment;type:varchar(16);not null;uniqueIndex:uq_scan_segment,priority:2"`
	LeanMassKg        float64  `gorm:"column:lean_mass_kg;type:double;not null"`
	FatMassKg         float64  `gorm:"column:fat_mass_kg;type:double;not null"`
	LeanPctOfStandard *float64 `gorm:"column:lean_pct_of_standard;type:double"`
	FatPctOfStandard  *float64 `gorm:"column:fat_pct_of_standard;type:double"`
}

func (BodyCompositionSegmentRecord) TableName() string { return "user_body_composition_segment" }

const (
	SegLeftArm  = "left_arm"
	SegRightArm = "right_arm"
	SegTrunk    = "trunk"
	SegLeftLeg  = "left_leg"
	SegRightLeg = "right_leg"
)

var AllBodySegments = map[string]bool{
	SegLeftArm: true, SegRightArm: true, SegTrunk: true, SegLeftLeg: true, SegRightLeg: true,
}
