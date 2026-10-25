// Package sessionclass is the deterministic training-session classifier for
// running activities (devops #743). It replaces the vendor-label passthrough in
// trainingloadsource.SessionClass with an evidence-based pipeline validated
// against a 1997-activity production snapshot with per-item adjudicated ground
// truth (see testdata/sessionclass_validation.json and the ticket).
//
// Signal priority follows the ticket's v4.2 order — explicit names > TE
// combinations > vendor labels (train_kind/train_type) > lap structure > pace
// zones (supporting only) — refined by the validation round:
//
//  1. Race reuses the production racedetection result (races table linkage)
//     instead of a competing heuristic; an unlinked race only qualifies via a
//     strong distance-band + near-max-effort pattern.
//  2. Vendor "quality" labels require corroboration (pace in M zone, lap
//     structure, sustained threshold HR or a hard-finish tail); watch auto
//     labels on easy-pace runs are otherwise rejected.
//  3. Long runs relax the ticket's 120min/25km absolute line to 110min/20km;
//     duration only counts at running pace (hikes never become long runs).
//  4. TE hard signals carry data-quality guards (implausible HR invalidates
//     Firstbeat effects).
package sessionclass

import (
	"math"
	"regexp"
	"strings"
)

// Class is the coarse session label stored for downstream consumers.
type Class string

const (
	ClassEasy        Class = "easy"
	ClassLongEasy    Class = "long_easy"
	ClassQuality     Class = "quality"
	ClassLongQuality Class = "long_quality"
	ClassRace        Class = "race"
	ClassStrides     Class = "strides"
	ClassOther       Class = "other"
)

// Subtype refines quality sessions (T/I/R/M/mixed) for credit splitting.
type Subtype string

const (
	SubThreshold  Subtype = "T"
	SubInterval   Subtype = "I"
	SubRepetition Subtype = "R"
	SubMarathon   Subtype = "M"
	SubMixed      Subtype = "mixed"
)

// Zone is one calibrated pace band, in seconds per kilometre. Fast is the
// quicker bound (smaller seconds), Slow the slower bound; either may be nil
// for open-ended bands.
type Zone struct {
	Fast *float64
	Slow *float64
}

// Zones carries the user's calibrated pace zones derived at classification
// time from the latest running calibration snapshot. A nil pointer on Marathon
// or Threshold disables the zone-dependent rules (degraded path).
type Zones struct {
	Easy       *Zone
	Marathon   *Zone
	Threshold  *Zone
	Interval   *Zone
	Repetition *Zone
}

// Lap is one fine-grained split (1 km auto laps; providers overlap 1 km/5 km/
// 10 km lap systems, so callers must pass only the 1 km set).
type Lap struct {
	DistanceM float64
	DurationS float64
	AvgHR     *float64
}

// Input is everything the classifier needs. Activity fields mirror
// storage.Activity; calibration and laps come from the caller; RaceLinked is
// the production racedetection verdict for this activity (races table row).
type Input struct {
	Name            string
	Sport           string // normalized: run_outdoor/run_indoor/run_trail/run_track/run_treadmill/...
	DistanceM       float64
	DurationS       float64
	AvgPaceSKm      *float64
	BestKmPaceSKm   *float64
	AvgHR           *float64
	MaxHR           *float64
	AerobicEffect   *float64 // Firstbeat aerobic effect (activities.aerobic_effect)
	AnaerobicEffect *float64 // Firstbeat anaerobic effect (activities.anaerobic_effect)
	AscentM         *float64
	TrainKind       string // COROS label ("" when NULL)
	TrainType       string // Garmin label ("" when NULL)
	ThresholdHR     *float64
	HRMaxEstimate   *float64
	Zones           *Zones
	Laps            []Lap
	RaceLinked      bool
}

// Result is the classification outcome plus the evidence trail.
type Result struct {
	Class      Class
	Subtype    Subtype
	Long       bool   // met long criteria (absolute or relaxed)
	Confidence string // high | medium | low
	Signals    []string
}

const (
	longAbsKm     = 25.0
	longAbsMin    = 120.0
	longRelaxKm   = 20.0
	longRelaxMin  = 110.0
	nameLongMinKm = 15.0
	hikePaceSKm   = 600.0 // slower than 9:00/km: walking, never a long *run*
)

var (
	raceWordRe     = regexp.MustCompile(`马拉松|越野赛|锦标赛|冠军赛|邀请赛|欢乐跑|半马|全马|半程|全程|接力赛|比赛|marathon`)
	trainWordRe    = regexp.MustCompile(`训练|备赛|课|测试|练习|模拟|配速|pace|prep|组|赛前|队员|团练|拉练|俱乐部|梯队|营`)
	hikeNameRe     = regexp.MustCompile(`徒步|hiking|爬山`)
	strideNameRe   = regexp.MustCompile(`快步|strides`)
	strideSuffixRe = regexp.MustCompile(`\+\s*\d*\s*(ST|st)\b`)
	longNameRe     = regexp.MustCompile(`长距离|长跑|LSD|lsd|long\s*run|拉练`)

	// strong quality words always claim the session as a workout
	qualityStrongRe = regexp.MustCompile(`间歇|间隙|interval|亚索|yasso|vo2|节奏|tempo|乳酸|阈值|lactate|threshold|变速|fartlek|法特莱克|金字塔|组合|mixed|冲刺|重复|repeat|sprint|强度|倒金字塔|测试`)
	// weak quality words only count without an easy-intent word in the name
	qualityWeakRe = regexp.MustCompile(`比赛配速|M配速|马配|马拉松配速|race\s*pace|渐加速|渐进`)
	easyNameRe    = regexp.MustCompile(`轻松|恢复|有氧|慢跑|散跑|easy|recovery|aerobic|regen|放松|唤醒|基础|悠跑|舒缓`)
	// explicit rep structure like 5*1.5k / 400*20 / 6组(800快+400慢) / 1500*3
	repStructureRe = regexp.MustCompile(`(\d+\s*[x×*·]\s*\d)|(\d+\s*组)|(快.*慢)|(慢.*快)`)
)

var vendorQualityKind = map[string]Subtype{
	"threshold": SubThreshold, "tempo": SubThreshold,
	"interval": SubInterval, "vo2max": SubInterval,
	"anaerobic": SubRepetition, "sprint": SubRepetition,
}
var vendorQualityType = map[string]Subtype{
	"LACTATE_THRESHOLD": SubThreshold, "TEMPO": SubThreshold,
	"INTERVAL": SubInterval, "VO2MAX": SubInterval, "VO2_MAX": SubInterval,
	"ANAEROBIC_CAPACITY": SubRepetition, "ANAEROBIC": SubRepetition,
	"SPRINT": SubRepetition, "SPEED": SubRepetition,
}

var vendorEasyKind = map[string]bool{"base": true, "aerobic": true, "recovery": true}
var vendorEasyType = map[string]bool{"AEROBIC_BASE": true, "AEROBIC": true, "RECOVERY": true}

// Classify runs the deterministic pipeline. Laps and zones may be empty/nil;
// the classifier degrades gracefully (TE + vendor + name rules) per ticket R5.
func Classify(in Input) Result {
	r := Result{Confidence: "low"}
	if isRunningSport(in.Sport) && repFragment(in) {
		// Sprint reps logged as their own sub-kilometre activities: the
		// threshold-or-faster pace held with average HR at the sustained
		// quality line carries the evidence (peak HR alone also matches
		// warm-up fragments, so it is not used).
		r.Class, r.Subtype, r.Confidence = ClassQuality, SubRepetition, "high"
		r.Signals = append(r.Signals, "short:rep-fragment")
		return r
	}
	if in.DistanceM < 200 || in.DurationS < 120 {
		// warm-up fragments and GPS junk: never a workout, never long
		r.Class = ClassEasy
		if isRunningSport(in.Sport) {
			return r
		}
		r.Class = ClassOther
		return r
	}
	km := in.DistanceM / 1000
	durMin := in.DurationS / 60
	pace := in.AvgPaceSKm
	ane, ae := in.AnaerobicEffect, in.AerobicEffect
	hr, maxhr := in.AvgHR, in.MaxHR
	thrHr, hrmax := in.ThresholdHR, in.HRMaxEstimate

	mSlow := zoneSlow(in.Zones, func(z *Zones) **Zone { return &z.Marathon })
	tSlow := zoneSlow(in.Zones, func(z *Zones) **Zone { return &z.Threshold })
	paceInM := pace != nil && mSlow != nil && *pace <= *mSlow*1.01
	isTrail := in.Sport == "run_trail" || (in.AscentM != nil && *in.AscentM > 300)

	ls := lapStats(in.Laps, mSlow, tSlow, thrHr)
	thrPct := 0.0
	if ls != nil {
		thrPct = ls.ThrHrTimePct
	}

	// TE credibility: implausible HR (strap failure / walking artifacts)
	// invalidates Firstbeat effects (#1118-style false anaerobic spikes).
	aneCredible := ane != nil
	if hr != nil && *hr > 0 && *hr < 100 {
		aneCredible = false
	}
	if aneCredible && hrmax != nil && *hrmax > 0 && maxhr != nil && *maxhr > 0 && *maxhr < 0.7**hrmax {
		aneCredible = false
	}

	// ---- 1. race (production racedetection reuse, independent of labels) ----
	if isRace(in, km, pace, hr, maxhr, hrmax, ane, aneCredible, r) {
		r.Class = ClassRace
		r.Confidence = "high"
		r.Signals = append(r.Signals, "race:detection")
		return r
	}

	// ---- strides / hiking ----
	if hikeNameRe.MatchString(in.Name) {
		r.Class = ClassEasy
		r.Signals = append(r.Signals, "name:hike")
		return r
	}
	if strideNameRe.MatchString(in.Name) && !strideSuffixRe.MatchString(in.Name) && km < 5 {
		r.Class = ClassStrides
		r.Confidence = "high"
		r.Signals = append(r.Signals, "name:strides")
		return r
	}

	// ---- long flag (absolute, relaxed, or explicit name with a floor) ----
	runPace := pace == nil || *pace <= hikePaceSKm
	isLong := km >= longAbsKm || (durMin >= longAbsMin && runPace) ||
		km >= longRelaxKm || (durMin >= longRelaxMin && runPace)
	nameLong := longNameRe.MatchString(in.Name) && km >= nameLongMinKm
	if nameLong {
		isLong = true
		r.Signals = append(r.Signals, "name:long")
	}

	// ---- 2. name layer ----
	nameQualitySub := qualitySubtypeFromName(in.Name)
	if nameQualitySub == SubMarathon && nameLong {
		// "长距离 20K 渐进": an explicit long plan with weak M/progressive
		// wording is a long run, not a workout name.
		nameQualitySub = ""
	}
	nameEasy := nameQualitySub == "" && easyNameRe.MatchString(in.Name)

	// Absolute vs relaxed long: the ticket's 25km/120min line splits embedded
	// intensity (long_quality) from a quality session that merely accumulated
	// distance. TE hard signals inside a relaxed-long run still mark an
	// endurance session with intensity; label/rule based quality stays quality.
	absoluteLong := km >= 23.0 || (durMin >= longAbsMin && runPace)
	// mLongQ: relaxed-long (20-23km) runs count as long_quality exactly when
	// half the distance sits in the marathon band (adjudication line F2).
	mLongQ := isLong && ls != nil && ls.MZoneFrac >= 0.5
	quality := func(sub Subtype, conf string, sig string, teHard bool) Result {
		if isLong && (absoluteLong || teHard) {
			r.Class, r.Subtype, r.Confidence = ClassLongQuality, sub, conf
			r.Long = true
			if sig != "" {
				r.Signals = append(r.Signals, sig, "long")
			}
			return r
		}
		r.Class, r.Subtype, r.Confidence = ClassQuality, sub, conf
		if isLong {
			r.Long = true
		}
		if sig != "" {
			r.Signals = append(r.Signals, sig)
		}
		return r
	}
	easyClass := func(sig string) Result {
		r.Long = isLong
		if isLong {
			r.Class, r.Confidence = ClassLongEasy, "medium"
		} else {
			r.Class, r.Confidence = ClassEasy, "medium"
		}
		if sig != "" {
			r.Signals = append(r.Signals, sig)
		}
		return r
	}

	// hard data-quality signals checked regardless of name intent (a planned
	// easy run raced hard is a workout; a planned workout jogged is not).
	r1Hard := aneCredible && aneVal(ane) >= 3.0
	// In the fragment zone a TE spike needs sustained threshold-or-faster
	// pace: jog+strides mixes also produce ane>=2 with peak HR at threshold.
	r1Variant := aneCredible && aneVal(ane) >= 2.0 && maxhr != nil && thrHr != nil &&
		*maxhr >= *thrHr && (paceInM || thrPct >= 0.25) && (!isTrail || paceInM) &&
		(km > 3.5 || (pace != nil && tSlow != nil && *pace <= *tSlow*1.05))
	r3 := paceInM && thrHr != nil && hr != nil && *hr >= 0.93**thrHr && durMin >= 20 && km >= 5 ||
		paceInM && ls != nil && ls.MZoneFrac >= 0.60 && thrHr != nil && hr != nil &&
			*hr >= 0.93**thrHr && durMin >= 12 && km >= 3.5
	r4 := ls != nil && ls.TailRatio > 0 && ls.TailRatio <= 0.86 && ls.TailPace > 0 && mSlow != nil &&
		ls.TailPace <= *mSlow && maxhr != nil && thrHr != nil && *maxhr >= *thrHr && ls.TailHR >= 0.93**thrHr
	r5 := km <= 3.5 && pace != nil && tSlow != nil && *pace <= *tSlow && thrHr != nil && hr != nil && *hr >= 0.93**thrHr
	r2 := ls != nil && km >= 5 && (ls.FastDistPct >= 0.30 || (ls.CV >= 0.20 && ls.FastDistPct >= 0.10 && !isTrail))

	if nameQualitySub != "" {
		// explicit workout name: needs any data corroboration (the plan may
		// have been aborted — "Tempo 8km" jogged easy stays easy).
		nameCorroborated := r1Hard || r1Variant || r2 || r3 || r4 || r5 ||
			(aneCredible && aneVal(ane) >= 1.0) || vendorQualityCorroborated(in, paceInM, thrPct, ls, r4) ||
			(isStrongQualityName(in.Name) && paceInM && thrPct >= 0.45) ||
			((hr == nil || *hr == 0) && (ls != nil && ls.CV >= 0.30 || straplessVendorQuality(in)))
		if nameCorroborated {
			return quality(nameQualitySub, "high", "name:quality", mLongQ)
		}
		return easyClass("name:quality~noEffort")
	}

	if r1Hard {
		return quality(teSubtype(in, tSlow), "high", "te:ane>=3", absoluteLong)
	}
	if r1Variant {
		return quality(teSubtype(in, tSlow), "high", "te:ane>=2&maxhr@thr", absoluteLong || mLongQ)
	}

	// long-only TE rules (absolute long only: relaxed-long quality is decided
	// above by the quality-signal split)
	if isLong {
		longTE := (aneCredible && aneVal(ane) >= 2.0) ||
			(ae != nil && *ae >= 4.5 && thrHr != nil && hr != nil && *hr > 0 && *hr >= 0.92**thrHr &&
				ls != nil && ls.MZoneFrac >= 0.5)
		if longTE {
			return quality(longQualitySubtype(in, pace, mSlow, ls), "medium", "te:long", true)
		}
		longM := ls != nil && ls.MZoneFrac >= 0.70 && thrHr != nil && hr != nil && *hr > 0 &&
			*hr >= 0.85**thrHr && ls.TailRatio <= 0.99 &&
			(*hr >= 0.87**thrHr || (ae != nil && *ae >= 4.5 && ls.TailRatio <= 0.97))
		longM50 := ls != nil && ls.MZoneFrac >= 0.50 && ls.TailRatio > 0 && ls.TailRatio <= 0.97 &&
			thrHr != nil && ls.TailHR >= 0.90**thrHr
		longFinishM := ls != nil && ls.TailRatio > 0 && ls.TailRatio <= 0.96 && mSlow != nil &&
			ls.TailPace > 0 && ls.TailPace <= *mSlow && thrHr != nil &&
			ls.TailHR >= 0.95**thrHr && hr != nil && *hr > 0 && *hr >= 0.88**thrHr
		if longM || longM50 || longFinishM {
			return quality(SubMarathon, "medium", "long:m-zone", true)
		}
	}

	if r2 {
		return quality(structureSubtype(in, ls), "high", "seg:structure", mLongQ)
	}
	if r3 {
		return quality(SubMarathon, "medium", "pace:m-sustained", mLongQ)
	}
	if r4 {
		return quality(SubMarathon, "medium", "seg:fast-finish", mLongQ)
	}
	if r5 {
		return quality(SubInterval, "medium", "short:all-out", false)
	}

	// ---- vendor labels (need corroboration for quality kinds) ----
	if vendorQualitySubtype(in, pace, tSlow) != "" && vendorQualityCorroborated(in, paceInM, thrPct, ls, r4) {
		return quality(vendorQualitySubtype(in, pace, tSlow), "medium", "vendor:quality", mLongQ)
	}
	if nameEasy {
		return easyClass("name:easy")
	}
	if vendorEasyKind[in.TrainKind] || vendorEasyType[strings.ToUpper(in.TrainType)] {
		return easyClass("vendor:easy")
	}
	return easyClass("")
}

// ---- race ----

func isRace(in Input, km float64, pace, hr, maxhr, hrmax, ane *float64, aneCredible bool, r Result) bool {
	if in.RaceLinked {
		return true
	}
	if in.TrainKind == "race" || strings.EqualFold(in.TrainType, "RACE") {
		return true
	}
	name := in.Name
	if raceWordRe.MatchString(name) && !trainWordRe.MatchString(name) {
		return true
	}
	// unlinked strong pattern: HM/FM band with near-max effort or a big
	// anaerobic load; shorter bands require the near-max form only.
	fmBand := km >= 41.9 && km <= 44.0
	nearMax := hrmax != nil && *hrmax > 0 && maxhr != nil && *maxhr >= 0.97**hrmax && hr != nil && *hr >= 0.88**hrmax
	// The distance-band fallback is deliberately narrow: hard training
	// sessions and club workouts sit inside every shorter band, so only a
	// full-marathon-distance effort at near-max heart rate qualifies without
	// the races-table link or an explicit race name.
	if fmBand && nearMax {
		return true
	}
	return false
}

// ---- helpers ----

func zoneSlow(z *Zones, pick func(*Zones) **Zone) *float64 {
	if z == nil {
		return nil
	}
	p := pick(z)
	if p == nil || *p == nil || (*p).Slow == nil {
		return nil
	}
	return (*p).Slow
}

func aneVal(v *float64) float64 {
	if v == nil {
		return 0
	}
	return *v
}

func isRunningSport(sport string) bool { return strings.HasPrefix(sport, "run") }

// repFragment detects sub-kilometre sprint-rep activities: threshold-or-
// faster pace held through the fragment with average HR at the sustained
// quality line.
func repFragment(in Input) bool {
	km := in.DistanceM / 1000
	if km > 3.5 || in.DurationS >= 40*60 || in.DurationS < 60 {
		return false
	}
	tSlow := zoneSlow(in.Zones, func(z *Zones) **Zone { return &z.Threshold })
	if tSlow == nil || in.AvgPaceSKm == nil {
		return false
	}
	if *in.AvgPaceSKm <= *tSlow && in.ThresholdHR != nil {
		if in.AvgHR != nil && *in.AvgHR >= 0.93**in.ThresholdHR {
			return true
		}
		// Average HR lags on 1-4 minute reps; a near-threshold peak plus
		// threshold pace, or a real anaerobic load, still marks a rep.
		if in.MaxHR != nil && *in.MaxHR >= 0.98**in.ThresholdHR {
			return true
		}
		if in.AnaerobicEffect != nil && *in.AnaerobicEffect >= 1 {
			return true
		}
	}
	// Fragment with a distinctly sub-threshold best split and a peak at
	// threshold: a sprint rep whose float/jog portion drags the average.
	return in.BestKmPaceSKm != nil && *in.BestKmPaceSKm > 0 && in.ThresholdHR != nil &&
		in.MaxHR != nil && *in.MaxHR >= *in.ThresholdHR && *in.BestKmPaceSKm <= *tSlow*0.92
}

func vendorQualitySubtype(in Input, pace, tSlow *float64) Subtype {
	if sub, ok := vendorQualityKind[in.TrainKind]; ok {
		return sub
	}
	if sub, ok := vendorQualityType[strings.ToUpper(in.TrainType)]; ok {
		return sub
	}
	_ = pace
	_ = tSlow
	return ""
}

// teSubtype: a bare TE hard signal is an anaerobic/VO2 stimulus unless the
// vendor kind or pace evidence says otherwise.
func teSubtype(in Input, tSlow *float64) Subtype {
	if sub := vendorQualitySubtype(in, in.AvgPaceSKm, tSlow); sub != "" {
		return sub
	}
	return SubInterval
}

func longQualitySubtype(in Input, pace, mSlow *float64, ls *lapSummary) Subtype {
	if sub := vendorQualitySubtype(in, pace, mSlow); sub != "" {
		return sub
	}
	if ls != nil && ls.MZoneFrac >= 0.6 {
		return SubMarathon
	}
	return SubMixed
}

func structureSubtype(in Input, ls *lapSummary) Subtype {
	if sub := vendorQualitySubtype(in, pace0(), nil); sub != "" {
		return sub
	}
	return SubMixed
}

func pace0() *float64 { return nil }

// vendorQualityCorroborated enforces the validation round's main fix: watch
// auto labels (Garmin TEMPO on easy-pace runs, COROS threshold on beginner
// jogs) only count as quality with independent evidence.
// vendorQualityCorroborated enforces the validation round's main fix: watch
// auto labels (Garmin TEMPO on easy-pace runs, COROS threshold on beginner
// jogs) only count as quality with independent evidence — lap structure, a
// hard-finish tail, sustained threshold HR at M pace, climb-threshold effort
// on trail, or sustained near-threshold effort independent of pace zone.
func vendorQualityCorroborated(in Input, paceInM bool, thrPct float64, ls *lapSummary, r4 bool) bool {
	if r4 {
		return true
	}
	if ls != nil && ls.FastDistPct >= 0.20 && in.DistanceM > 3500 {
		return true
	}
	hr, maxhr, thr := in.AvgHR, in.MaxHR, in.ThresholdHR
	atThr := maxhr != nil && thr != nil && *maxhr >= *thr
	if paceInM && thrPct >= 0.30 && hr != nil && thr != nil && *hr >= 0.93**thr &&
		in.DistanceM > 3500 {
		// Sub-3.5 km fragments only corroborate at threshold-or-faster pace
		// (see repFragment); M-pace vendor labels there are warm-up noise.
		return true
	}
	isTrail := in.Sport == "run_trail" || (in.AscentM != nil && *in.AscentM > 300)
	if isTrail && thrPct >= 0.50 && atThr {
		return true
	}
	if thrPct >= 0.50 && hr != nil && thr != nil && *hr >= 0.95**thr && atThr && in.DurationS >= 40*60 &&
		ls != nil && ls.MZoneFrac >= 0.40 {
		return true
	}
	return false
}

// straplessVendorQuality: without a HR strap the watch's own interval/
// threshold detection is pace-structure based and remains meaningful.
func straplessVendorQuality(in Input) bool {
	if _, ok := vendorQualityKind[in.TrainKind]; ok {
		return true
	}
	_, ok := vendorQualityType[strings.ToUpper(in.TrainType)]
	return ok
}

func isStrongQualityName(name string) bool {
	return qualityStrongRe.MatchString(name)
}

func qualitySubtypeFromName(name string) Subtype {
	if repStructureRe.MatchString(name) {
		return SubMixed
	}
	if qualityStrongRe.MatchString(name) {
		switch {
		case regexp.MustCompile(`间歇|间隙|interval|亚索|yasso|vo2|倒金字塔`).MatchString(name):
			return SubInterval
		case regexp.MustCompile(`节奏|tempo|乳酸|阈值|lactate|threshold`).MatchString(name):
			return SubThreshold
		case regexp.MustCompile(`变速|fartlek|法特莱克|金字塔|组合|mixed`).MatchString(name):
			return SubMixed
		case regexp.MustCompile(`冲刺|重复|repeat|sprint`).MatchString(name):
			return SubRepetition
		default:
			return SubMixed // 强度/测试
		}
	}
	if qualityWeakRe.MatchString(name) && !easyNameRe.MatchString(name) {
		return SubMarathon
	}
	return ""
}

// ---- lap statistics ----

type lapSummary struct {
	NLaps        int
	AvgPace      float64
	TailPace     float64
	TailRatio    float64
	TailHR       float64
	CV           float64
	ThrHrTimePct float64
	MZoneFrac    float64
	FastDistPct  float64
}

// lapStats mirrors the validated JS implementation: tail = last 20% of
// distance at per-lap granularity, CV is the distance-weighted coefficient of
// variation of lap paces, M-zone/fast fractions share of distance.
func lapStats(laps []Lap, mSlow, tSlow, thrHr *float64) *lapSummary {
	if len(laps) < 2 {
		return nil
	}
	totalDist, totalDur := 0.0, 0.0
	for _, l := range laps {
		if l.DistanceM <= 100 {
			continue
		}
		totalDist += l.DistanceM
		totalDur += l.DurationS
	}
	if totalDist < 500 || totalDur < 300 {
		return nil
	}
	avgPace := totalDur / (totalDist / 1000)

	target := totalDist * 0.8
	acc, tailDur, tailDist := 0.0, 0.0, 0.0
	hrSum, hrN := 0.0, 0
	wSum, mean, varr := 0.0, 0.0, 0.0
	var paces []float64
	thrHrTime, mDist, fastDist := 0.0, 0.0, 0.0
	for _, l := range laps {
		if l.DistanceM <= 100 {
			continue
		}
		p := l.DurationS / (l.DistanceM / 1000)
		paces = append(paces, p)
		wSum += l.DistanceM
		mean += p * l.DistanceM
		if thrHr != nil && l.AvgHR != nil && *l.AvgHR >= 0.92**thrHr {
			thrHrTime += l.DurationS
		}
		if mSlow != nil && p <= *mSlow {
			mDist += l.DistanceM
		}
		if tSlow != nil && p <= *tSlow {
			fastDist += l.DistanceM
		}
		after := acc + l.DistanceM
		if after > target {
			frac := (after - math.Max(target, acc)) / l.DistanceM
			tailDur += l.DurationS * frac
			tailDist += l.DistanceM * frac
			if frac > 0.5 && l.AvgHR != nil {
				hrSum += *l.AvgHR
				hrN++
			}
		}
		acc = after
	}
	if wSum > 0 {
		mean /= wSum
		for i, p := range paces {
			varr += (p - mean) * (p - mean) * lapsWeight(laps, i)
		}
		varr /= wSum
	}
	s := &lapSummary{
		NLaps:        len(paces),
		AvgPace:      avgPace,
		ThrHrTimePct: thrHrTime / totalDur,
		MZoneFrac:    mDist / totalDist,
		FastDistPct:  fastDist / totalDist,
	}
	if tailDist > 500 {
		s.TailPace = tailDur / (tailDist / 1000)
		s.TailRatio = s.TailPace / avgPace
	}
	if hrN > 0 {
		s.TailHR = hrSum / float64(hrN)
	}
	if wSum > 0 && mean > 0 {
		s.CV = math.Sqrt(varr) / mean
	}
	return s
}

func lapsWeight(laps []Lap, i int) float64 {
	j, seen := 0, -1
	for _, l := range laps {
		if l.DistanceM <= 100 {
			continue
		}
		seen++
		if seen == i {
			return l.DistanceM
		}
	}
	_ = j
	return 1
}
