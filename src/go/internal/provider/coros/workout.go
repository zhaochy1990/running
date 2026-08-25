// workout.go builds and pushes running + strength training workouts to the
// COROS Training Hub schedule. Go port of coros_sync.workout.
//
// Running workout structure (reverse-engineered from COROS Training Hub):
//   - exerciseType: 1=warm-up, 2=training, 3=cool-down, 4=recovery
//   - targetType: 2=time(seconds), 5=distance(mm)
//   - intensityType: 0=no pace target, 3=pace target
//   - intensityValue/intensityValueExtend: pace range in ms/km (e.g. 300000=5:00/km)
//   - sportType: 1=running
//
// Strength workout structure:
//   - sportType: 4=strength
//   - exercises are full objects from the COROS exercise library (via
//     Client.QueryExercises), with originId (library id) plus a sequential id
//   - targetType: 2=time(seconds), 3=reps
//
// Schedule is pushed via POST /training/schedule/update with:
//   - entities[]: date + bar chart visualization
//   - programs[]: full workout definition with exercises
package coros

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"strconv"
	"strings"
)

// Exercise templates for running workouts (COROS library entries).
var (
	warmupTime  = map[string]any{"name": "T1120", "originId": "425895398452936705", "overview": "sid_run_warm_up_dist", "createTimestamp": 1586584068, "defaultOrder": 1}
	warmupDist  = map[string]any{"name": "T1121", "originId": "425895427796307968", "overview": "sid_run_warm_up_time", "createTimestamp": 1586584140, "defaultOrder": 1}
	trainingTpl = map[string]any{"name": "T3001", "originId": "426109589008859136", "overview": "sid_run_training", "createTimestamp": 1587381919, "defaultOrder": 2}
	cooldownTpl = map[string]any{"name": "T1122", "originId": "425895456971866112", "overview": "sid_run_cool_down_dist", "createTimestamp": 1586584214, "defaultOrder": 3}
	recoveryTpl = map[string]any{"name": "T1123", "originId": "425895398452936705", "overview": "sid_run_cool_down_dist", "createTimestamp": 1586584214, "defaultOrder": 3}
)

// Source images for running workout types.
var sourceURLs = map[string]string{
	"easy":     "https://oss.coros.com/source/source_default/0/37a30375849b49f89cbd5ab80eec5c7e.jpg",
	"tempo":    "https://oss.coros.com/source/source_default/0/8f65f771b129460abce14d3376a39d83.jpg",
	"interval": "https://oss.coros.com/source/source_default/0/2fbd46e17bc54bc5873415c9fa767bdc.jpg",
	"long":     "https://oss.coros.com/source/source_default/0/8f65f771b129460abce14d3376a39d83.jpg",
}

const (
	runSourceID       = "425868125142171648"
	strengthSourceID  = "425846071290413056"
	strengthSourceURL = "https://oss.coros.com/source/source_default/0/8f65f771b129460abce14d3376a39d83.jpg"
)

// paceToMs converts a pace string like "5:30" (min:sec per km) to milliseconds
// per km — the COROS intensityValue unit.
func paceToMs(pace string) (int, error) {
	parts := strings.Split(strings.TrimSpace(pace), ":")
	if len(parts) < 1 || len(parts) > 2 {
		return 0, fmt.Errorf("invalid pace %q", pace)
	}
	min, err := strconv.Atoi(parts[0])
	if err != nil {
		return 0, fmt.Errorf("invalid pace %q: %w", pace, err)
	}
	sec := 0
	if len(parts) == 2 {
		sec, err = strconv.Atoi(parts[1])
		if err != nil {
			return 0, fmt.Errorf("invalid pace %q: %w", pace, err)
		}
	}
	return (min*60 + sec) * 1000, nil
}

// ─────────────────────────────────────────────────────────────────────────────
// Running workout builder
// ─────────────────────────────────────────────────────────────────────────────

// runSegment is one segment of a running workout (COROS shape).
type runSegment struct {
	segmentType       string   // "warmup", "training", "cooldown", "recovery", "interval"
	distanceKm        *float64 // distance in km
	durationMin       *float64 // duration in minutes
	paceLow           *string  // slower pace "5:40"
	paceHigh          *string  // faster pace "5:20"
	sets              int
	restType          int // 0=none, 2=time(seconds), 5=distance(mm) — carried for API parity, unused in payload
	restValue         int // rest duration in seconds or distance in mm — carried for API parity, unused in payload
	recoveryDurationS int // interval group: recovery time in seconds between reps
}

// RunWorkoutBuilder is a complete running workout to push to COROS. It is the
// Go port of coros_sync.workout.RunWorkout (fluent add_* builders).
type RunWorkoutBuilder struct {
	name        string
	date        string // YYYYMMDD
	segments    []runSegment
	workoutType string // easy, tempo, interval, long
}

// NewRunWorkoutBuilder starts a running workout with the given name, COROS date
// (YYYYMMDD) and type (easy/tempo/interval/long — picks the source image).
func NewRunWorkoutBuilder(name, date, workoutType string) *RunWorkoutBuilder {
	return &RunWorkoutBuilder{name: name, date: date, workoutType: workoutType}
}

func (w *RunWorkoutBuilder) addWarmup(durationMin, distanceKm *float64, paceLow, paceHigh *string) *RunWorkoutBuilder {
	if durationMin == nil && distanceKm == nil {
		durationMin = floatPtrOf(5)
	}
	w.segments = append(w.segments, runSegment{
		segmentType: "warmup", durationMin: durationMin, distanceKm: distanceKm,
		paceLow: paceLow, paceHigh: paceHigh, sets: 1,
	})
	return w
}

func (w *RunWorkoutBuilder) addTraining(distanceKm, durationMin *float64, paceLow, paceHigh *string, sets, restType, restValue int) *RunWorkoutBuilder {
	w.segments = append(w.segments, runSegment{
		segmentType: "training", distanceKm: distanceKm, durationMin: durationMin,
		paceLow: paceLow, paceHigh: paceHigh, sets: sets,
		restType: restType, restValue: restValue,
	})
	return w
}

func (w *RunWorkoutBuilder) addRecovery(durationMin, distanceKm *float64, paceLow, paceHigh *string) *RunWorkoutBuilder {
	if durationMin == nil && distanceKm == nil {
		durationMin = floatPtrOf(3)
	}
	w.segments = append(w.segments, runSegment{
		segmentType: "recovery", durationMin: durationMin, distanceKm: distanceKm,
		paceLow: paceLow, paceHigh: paceHigh, sets: 1,
	})
	return w
}

// addInterval adds an interval group: N reps of work + recovery in COROS group
// format (a group container exerciseType=0 with training + recovery children).
func (w *RunWorkoutBuilder) addInterval(sets int, distanceKm, durationMin *float64, paceLow, paceHigh *string, recoveryDurationS int) *RunWorkoutBuilder {
	w.segments = append(w.segments, runSegment{
		segmentType: "interval", distanceKm: distanceKm, durationMin: durationMin,
		paceLow: paceLow, paceHigh: paceHigh, sets: sets,
		recoveryDurationS: recoveryDurationS,
	})
	return w
}

func (w *RunWorkoutBuilder) addCooldown(durationMin, distanceKm *float64, paceLow, paceHigh *string) *RunWorkoutBuilder {
	if durationMin == nil && distanceKm == nil {
		durationMin = floatPtrOf(5)
	}
	w.segments = append(w.segments, runSegment{
		segmentType: "cooldown", durationMin: durationMin, distanceKm: distanceKm,
		paceLow: paceLow, paceHigh: paceHigh, sets: 1,
	})
	return w
}

// segTarget returns (targetType, targetValue) for a segment. Distance wins over
// duration; when neither is set the default duration (minutes) is used.
func segTarget(distanceKm, durationMin *float64, defaultMin float64) (int, int) {
	if distanceKm != nil {
		return 5, int(*distanceKm * 100_000)
	}
	d := defaultMin
	if durationMin != nil {
		d = *durationMin
	}
	return 2, int(d * 60)
}

// makeExercise builds one running exercise object.
// exerciseType: 1=warmup, 2=training, 3=cooldown, 4=recovery;
// targetType: 2=time(s), 5=distance(mm).
func makeExercise(exerciseType, sortNo, targetType, targetValue int, template map[string]any, paceLow, paceHigh *string, sets int) map[string]any {
	ex := map[string]any{
		"access":                 0,
		"createTimestamp":        template["createTimestamp"],
		"defaultOrder":           template["defaultOrder"],
		"equipment":              []any{1},
		"exerciseType":           exerciseType,
		"groupId":                "",
		"hrType":                 0,
		"id":                     sortNo,
		"intensityCustom":        0,
		"intensityDisplayUnit":   0,
		"intensityMultiplier":    0,
		"intensityPercent":       0,
		"intensityPercentExtend": 0,
		"intensityType":          0,
		"intensityValue":         0,
		"intensityValueExtend":   0,
		"isDefaultAdd":           0,
		"isGroup":                false,
		"isIntensityPercent":     false,
		"name":                   template["name"],
		"originId":               template["originId"],
		"overview":               template["overview"],
		"part":                   []any{0},
		"restType":               3,
		"restValue":              0,
		"sets":                   sets,
		"sortNo":                 sortNo,
		"sourceId":               "0",
		"sourceUrl":              "",
		"sportType":              1,
		"subType":                0,
		"targetDisplayUnit":      0,
		"targetType":             targetType,
		"targetValue":            targetValue,
		"userId":                 0,
		"videoUrl":               "",
	}
	if exerciseType == 2 {
		ex["isDefaultAdd"] = 1
	}
	if targetType == 5 {
		ex["targetDisplayUnit"] = 1
	}
	if paceLow != nil && paceHigh != nil {
		// COROS renders intensityValue first, so it must hold the FASTER bound
		// (smaller ms/km) for the watch to show "4:20-4:30", not the reversed
		// "4:30-4:20". Normalize by numeric value rather than trusting caller
		// ordering — authored plan.json has been inconsistent about which of
		// low/high is the faster bound.
		msA, errA := paceToMs(*paceLow)
		msB, errB := paceToMs(*paceHigh)
		if errA == nil && errB == nil {
			fastMS, slowMS := msA, msB
			if msA > msB {
				fastMS, slowMS = msB, msA
			}
			ex["intensityType"] = 3
			ex["intensityValue"] = fastMS
			ex["intensityValueExtend"] = slowMS
			ex["intensityDisplayUnit"] = "1"
			ex["intensityMultiplier"] = 1000
			// intensityPercent is derived from pace relative to threshold:
			// approximate pace_ms / threshold_pace_ms * 100 * 1000.
			ex["intensityPercent"] = fastMS / 5
			ex["intensityPercentExtend"] = slowMS / 5
		}
	}
	return ex
}

// buildExercises converts the segments into the COROS exercise list. IDs are a
// global sequential counter; sortNo orders the segments (interval groups share
// the group's sortNo for work, +1 for recovery).
func (w *RunWorkoutBuilder) buildExercises() []map[string]any {
	var exercises []map[string]any
	sortNo := 0
	nextID := 0
	for _, seg := range w.segments {
		sortNo++
		nextID++
		if seg.segmentType == "interval" {
			// COROS interval group format:
			//   1. Group container (exerciseType=0, isGroup=true, sets=N)
			//   2. Training exercise (exerciseType=2, groupId=group_id)
			//   3. Recovery exercise (exerciseType=4, groupId=group_id)
			groupID := nextID
			group := map[string]any{
				"access": 0, "defaultOrder": 0, "exerciseType": 0,
				"id": groupID, "intensityCustom": 0, "intensityMultiplier": 0,
				"intensityType": 0, "intensityValue": 0, "intensityValueExtend": 0,
				"isDefaultAdd": 0, "isGroup": true, "name": "", "originId": "",
				"overview": "", "programId": "", "restType": 0,
				"restValue": seg.recoveryDurationS, "sets": seg.sets,
				"sortNo": sortNo, "sourceId": "0", "sourceUrl": "",
				"sportType": 0, "subType": 0, "targetType": "", "targetValue": 0,
				"videoUrl": "",
			}
			exercises = append(exercises, group)

			// Training interval (same sortNo as group, unique id).
			nextID++
			targetType, targetValue := segTarget(seg.distanceKm, seg.durationMin, 5)
			trainingEx := makeExercise(2, sortNo, targetType, targetValue, trainingTpl,
				seg.paceLow, seg.paceHigh, 1)
			trainingEx["id"] = nextID
			trainingEx["groupId"] = groupID
			exercises = append(exercises, trainingEx)

			// Recovery between reps (next sortNo, unique id).
			sortNo++
			nextID++
			recoveryEx := makeExercise(4, sortNo, 2, seg.recoveryDurationS, recoveryTpl, nil, nil, 1)
			recoveryEx["id"] = nextID
			recoveryEx["groupId"] = groupID
			exercises = append(exercises, recoveryEx)
			continue
		}

		var exType int
		var template map[string]any
		var defaultMin float64
		switch seg.segmentType {
		case "warmup":
			exType, template, defaultMin = 1, warmupTime, 5
			if seg.distanceKm != nil {
				template = warmupDist
			}
		case "recovery":
			exType, template, defaultMin = 4, recoveryTpl, 3
		case "cooldown":
			exType, template, defaultMin = 3, cooldownTpl, 5
		default: // training
			exType, template, defaultMin = 2, trainingTpl, 30
		}
		targetType, targetValue := segTarget(seg.distanceKm, seg.durationMin, defaultMin)
		ex := makeExercise(exType, sortNo, targetType, targetValue, template,
			seg.paceLow, seg.paceHigh, seg.sets)
		ex["id"] = nextID
		exercises = append(exercises, ex)
	}
	return exercises
}

// buildBarChart builds the exerciseBarChart visualization data.
func buildBarChart(exercises []map[string]any) []map[string]any {
	values := make([]float64, len(exercises))
	total := 0.0
	for i, ex := range exercises {
		val := floatAny(ex["targetValue"])
		if intAny(ex["targetType"]) == 5 { // distance: mm to m-ish for ratio
			val = val / 1000
		}
		values[i] = val
		total += val
	}
	if total == 0 {
		total = 1
	}
	chart := make([]map[string]any, 0, len(exercises))
	for i, ex := range exercises {
		width := math.Round(values[i]/total*100*100) / 100
		height := 5
		if intAny(ex["exerciseType"]) == 2 {
			height = 65
		}
		chart = append(chart, map[string]any{
			"exerciseId":   strAny(ex["id"]),
			"exerciseType": ex["exerciseType"],
			"height":       height,
			"name":         ex["name"],
			"targetType":   ex["targetType"],
			"targetValue":  ex["targetValue"],
			"value":        values[i],
			"width":        width,
			"widthFill":    0,
		})
	}
	return chart
}

// BuildPayload assembles the full /training/schedule/update body.
func (w *RunWorkoutBuilder) BuildPayload(idInPlan int) map[string]any {
	exercises := w.buildExercises()
	barChart := buildBarChart(exercises)
	totalSets := 0
	for _, ex := range exercises {
		totalSets += intAny(ex["sets"])
	}
	sourceURL := sourceURLs[w.workoutType]
	if sourceURL == "" {
		sourceURL = sourceURLs["easy"]
	}

	program := map[string]any{
		"access": 1, "authorId": "0", "createTimestamp": 0,
		"distance": 0, "duration": 0, "essence": 0,
		"estimatedType": 0, "estimatedValue": 0, "exerciseNum": 0,
		"exercises": exercises,
		"headPic":   "", "id": "0", "idInPlan": idInPlan,
		"name": w.name, "nickname": "",
		"originEssence": 0, "overview": "", "pbVersion": 2,
		"planIdIndex": 0, "poolLength": 2500, "profile": "",
		"referExercise": map[string]any{"intensityType": 0, "hrType": 0, "valueType": 0},
		"sex":           0, "shareUrl": "", "simple": false,
		"sourceUrl": sourceURL,
		"sportType": 1, "star": 0, "subType": 65535,
		"targetType": 0, "targetValue": 0, "thirdPartyId": 0,
		"totalSets": totalSets, "trainingLoad": 0,
		"type": 0, "unit": 0, "userId": "0", "version": 0,
		"videoCoverUrl": "", "videoUrl": "",
		"fastIntensityTypeName": "custom",
		"poolLengthId":          1,
		"poolLengthUnit":        2,
		"sourceId":              runSourceID,
	}

	entity := map[string]any{
		"happenDay":        w.date,
		"idInPlan":         idInPlan,
		"sortNo":           0,
		"dayNo":            0,
		"sortNoInPlan":     0,
		"sortNoInSchedule": 0,
		"exerciseBarChart": barChart,
	}

	return map[string]any{
		"entities":       []any{entity},
		"programs":       []any{program},
		"versionObjects": []any{map[string]any{"id": idInPlan, "status": 1}},
		"pbVersion":      2,
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Strength workout builder
// ─────────────────────────────────────────────────────────────────────────────

// StrengthExercise is a single exercise in a strength workout.
type StrengthExercise struct {
	exerciseData map[string]any // full exercise object from QueryExercises
	sets         int
	targetType   int // 2=time(seconds), 3=reps
	targetValue  int // reps or seconds depending on targetType
	restType     int // 1=time-based rest
	restValue    int // seconds of rest between sets
}

// StrengthWorkoutBuilder is a strength training workout to push to COROS. Go
// port of coros_sync.workout.StrengthWorkout.
type StrengthWorkoutBuilder struct {
	name      string
	date      string // YYYYMMDD
	exercises []StrengthExercise
}

// NewStrengthWorkoutBuilder starts a strength workout.
func NewStrengthWorkoutBuilder(name, date string) *StrengthWorkoutBuilder {
	return &StrengthWorkoutBuilder{name: name, date: date}
}

// addExercise appends an exercise from the COROS library. targetType/value
// default to the library exercise's own when 0 (callers pass explicit values
// from the normalized spec).
func (w *StrengthWorkoutBuilder) addExercise(exerciseData map[string]any, sets, targetType, targetValue, restValue int) *StrengthWorkoutBuilder {
	if targetType == 0 {
		targetType = intAny(exerciseData["targetType"])
		if targetType == 0 {
			targetType = 3
		}
	}
	if targetValue == 0 {
		targetValue = intAny(exerciseData["targetValue"])
		if targetValue == 0 {
			targetValue = 12
		}
	}
	w.exercises = append(w.exercises, StrengthExercise{
		exerciseData: exerciseData, sets: sets, targetType: targetType,
		targetValue: targetValue, restType: 1, restValue: restValue,
	})
	return w
}

// buildExercises stamps the sequential ids / target / rest onto copies of the
// library exercise objects.
func (w *StrengthWorkoutBuilder) buildExercises() []map[string]any {
	exercises := make([]map[string]any, 0, len(w.exercises))
	for i, ex := range w.exercises {
		exercise := cloneMap(ex.exerciseData)
		exercise["originId"] = strAny(exercise["id"]) // library ID becomes originId
		exercise["id"] = i + 1                        // sequential counter
		exercise["sortNo"] = i
		exercise["sets"] = ex.sets
		exercise["targetType"] = ex.targetType
		exercise["targetValue"] = ex.targetValue
		exercise["restType"] = ex.restType
		exercise["restValue"] = ex.restValue
		exercise["groupId"] = ""
		// Ensure these fields exist.
		setDefault(exercise, "hrType", 0)
		setDefault(exercise, "intensityValueExtend", 0)
		setDefault(exercise, "intensityMultiplier", 0)
		setDefault(exercise, "intensityPercent", 0)
		setDefault(exercise, "intensityPercentExtend", 0)
		setDefault(exercise, "intensityDisplayUnit", "6")
		setDefault(exercise, "targetDisplayUnit", 0)
		exercises = append(exercises, exercise)
	}
	return exercises
}

// BuildPayload assembles the full /training/schedule/update body.
func (w *StrengthWorkoutBuilder) BuildPayload(idInPlan int) map[string]any {
	exercises := w.buildExercises()
	totalSets := 0
	for _, ex := range w.exercises {
		totalSets += ex.sets
	}

	program := map[string]any{
		"access": 1, "authorId": "0", "createTimestamp": 0,
		"distance": 0, "duration": 0, "essence": 0,
		"estimatedType": 0, "estimatedValue": 0, "exerciseNum": 0,
		"exercises": exercises,
		"headPic":   "", "id": "0", "idInPlan": idInPlan,
		"name": w.name, "nickname": "",
		"originEssence": 0, "overview": "", "pbVersion": 2,
		"planIdIndex": 0, "poolLength": 2500, "profile": "",
		"referExercise": map[string]any{"intensityType": 1, "hrType": 0, "valueType": 1},
		"sex":           0, "shareUrl": "", "simple": false,
		"sourceUrl": strengthSourceURL,
		"sportType": 4, "star": 0, "subType": 65535,
		"targetType": 0, "targetValue": 0, "thirdPartyId": 0,
		"totalSets": totalSets, "trainingLoad": 0,
		"type": 0, "unit": 0, "userId": "0", "version": 0,
		"videoCoverUrl": "", "videoUrl": "",
		"fastIntensityTypeName": "weight",
		"poolLengthId":          1,
		"poolLengthUnit":        2,
		"sourceId":              strengthSourceID,
	}

	entity := map[string]any{
		"happenDay":        w.date,
		"idInPlan":         idInPlan,
		"sortNo":           0,
		"dayNo":            0,
		"sortNoInPlan":     0,
		"sortNoInSchedule": 0,
	}

	return map[string]any{
		"entities":       []any{entity},
		"programs":       []any{program},
		"versionObjects": []any{map[string]any{"id": idInPlan, "status": 1}},
		"pbVersion":      2,
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Push flow (calculate → update)
// ─────────────────────────────────────────────────────────────────────────────

// nextIDInPlan queries the schedule around date to find the next available
// idInPlan and the current pbVersion (needed for a conflict-free update).
func nextIDInPlan(ctx context.Context, client *Client, date string) (int, int, error) {
	start := date[:6] + "01" // first of the month
	month, _ := strconv.Atoi(date[4:6])
	year, _ := strconv.Atoi(date[:4])
	endMonth := month + 2
	endYear := year
	if endMonth > 12 {
		endMonth -= 12
		endYear++
	}
	end := fmt.Sprintf("%04d%02d28", endYear, endMonth)

	data, err := client.QuerySchedule(ctx, start, end)
	if err != nil {
		return 0, 0, err
	}
	var sched struct {
		MaxIDInPlan any `json:"maxIdInPlan"`
		PBVersion   any `json:"pbVersion"`
	}
	if err := json.Unmarshal(data, &sched); err != nil {
		return 0, 0, fmt.Errorf("coros: decode schedule: %w", err)
	}
	pbVersion := intAny(sched.PBVersion)
	if pbVersion == 0 {
		pbVersion = 2
	}
	return intAny(sched.MaxIDInPlan) + 1, pbVersion, nil
}

// applyCalc merges the calculate response's derived metrics back onto the
// program (distance/duration/trainingLoad/sets/pitch/display unit).
func applyCalc(program map[string]any, calcData map[string]any) {
	program["distance"] = pickAny(calcData, "planDistance", "distance", "0")
	program["duration"] = pickAny(calcData, "planDuration", "duration", 0)
	program["trainingLoad"] = pickAny(calcData, "planTrainingLoad", "trainingLoad", 0)
	program["totalSets"] = pickAny(calcData, "planSets", "sets", program["totalSets"])
	program["sets"] = program["totalSets"]
	program["pitch"] = pickAny(calcData, "planPitch", "pitch", 0)
	if v, ok := calcData["distanceDisplayUnit"]; ok {
		program["distanceDisplayUnit"] = v
	}
}

// pushWorkout runs the calculate → update flow for a running workout and
// returns the watch-side idInPlan (parsed from the update response, falling
// back to the id we computed).
func pushWorkout(ctx context.Context, client *Client, w *RunWorkoutBuilder) (string, error) {
	nextID, pbVersion, err := nextIDInPlan(ctx, client, w.date)
	if err != nil {
		return "", err
	}
	payload := w.BuildPayload(nextID)
	program := payload["programs"].([]any)[0].(map[string]any)
	entity := payload["entities"].([]any)[0].(map[string]any)

	calc, err := client.CalculateWorkout(ctx, program, entity)
	if err != nil {
		return "", err
	}
	var calcData map[string]any
	_ = json.Unmarshal(calc, &calcData)
	applyCalc(program, calcData)
	// Use bar chart from the calculate response (has correct widths).
	if chart, ok := calcData["exerciseBarChart"]; ok {
		program["exerciseBarChart"] = chart
		entity["exerciseBarChart"] = chart
	}

	resp, err := client.UpdateSchedule(ctx,
		payload["entities"].([]any), payload["programs"].([]any),
		payload["versionObjects"].([]any), pbVersion)
	if err != nil {
		return "", err
	}
	return extractIDInPlan(resp, strconv.Itoa(nextID)), nil
}

// pushStrengthWorkout runs the calculate → update flow for a strength workout.
func pushStrengthWorkout(ctx context.Context, client *Client, w *StrengthWorkoutBuilder) (string, error) {
	nextID, pbVersion, err := nextIDInPlan(ctx, client, w.date)
	if err != nil {
		return "", err
	}
	payload := w.BuildPayload(nextID)
	program := payload["programs"].([]any)[0].(map[string]any)
	entity := payload["entities"].([]any)[0].(map[string]any)

	calc, err := client.CalculateWorkout(ctx, program, entity)
	if err != nil {
		return "", err
	}
	var calcData map[string]any
	_ = json.Unmarshal(calc, &calcData)
	applyCalc(program, calcData)

	resp, err := client.UpdateSchedule(ctx,
		payload["entities"].([]any), payload["programs"].([]any),
		payload["versionObjects"].([]any), pbVersion)
	if err != nil {
		return "", err
	}
	return extractIDInPlan(resp, strconv.Itoa(nextID)), nil
}

// extractIDInPlan pulls the idInPlan out of a schedule/update response
// (data.programs[0].idInPlan when present), falling back to the id we sent.
func extractIDInPlan(resp json.RawMessage, fallback string) string {
	if len(resp) == 0 {
		return fallback
	}
	var env struct {
		Programs []struct {
			IDInPlan any `json:"idInPlan"`
		} `json:"programs"`
	}
	if err := json.Unmarshal(resp, &env); err == nil && len(env.Programs) > 0 {
		if id := strAny(env.Programs[0].IDInPlan); id != "" {
			return id
		}
	}
	return fallback
}

// ─────────────────────────────────────────────────────────────────────────────
// Convenience builders for common workout types (CLI parity with Python)
// ─────────────────────────────────────────────────────────────────────────────

// EasyRun is an easy aerobic run: one training segment, distance + pace range.
func EasyRun(date string, distanceKm float64, paceLow, paceHigh string) *RunWorkoutBuilder {
	return NewRunWorkoutBuilder(fmt.Sprintf("Easy Run %gkm", distanceKm), date, "easy").
		addTraining(floatPtrOf(distanceKm), nil, stringPtrOf(paceLow), stringPtrOf(paceHigh), 1, 0, 0)
}

// TempoRun is a tempo/threshold run.
func TempoRun(date string, tempoKm float64, paceLow, paceHigh string) *RunWorkoutBuilder {
	return NewRunWorkoutBuilder(fmt.Sprintf("Tempo %gkm @ %s", tempoKm, paceHigh), date, "tempo").
		addTraining(floatPtrOf(tempoKm), nil, stringPtrOf(paceLow), stringPtrOf(paceHigh), 1, 0, 0)
}

// IntervalRun is an interval workout with repeats using the COROS group format.
func IntervalRun(date string, reps, intervalM int, paceLow, paceHigh string, recoveryMin float64) *RunWorkoutBuilder {
	return NewRunWorkoutBuilder(fmt.Sprintf("%dx%dm Intervals", reps, intervalM), date, "interval").
		addInterval(reps, floatPtrOf(float64(intervalM)/1000), nil, stringPtrOf(paceLow), stringPtrOf(paceHigh), int(recoveryMin*60))
}

// LongRun is a long run with an optional marathon-pace finish.
func LongRun(date string, totalKm, easyKm, mpKm float64, easyPaceLow, easyPaceHigh, mpPaceLow, mpPaceHigh string) *RunWorkoutBuilder {
	w := NewRunWorkoutBuilder(fmt.Sprintf("Long Run %gkm", totalKm), date, "long").
		addTraining(floatPtrOf(easyKm), nil, stringPtrOf(easyPaceLow), stringPtrOf(easyPaceHigh), 1, 0, 0)
	if mpKm > 0 {
		w.addTraining(floatPtrOf(mpKm), nil, stringPtrOf(mpPaceLow), stringPtrOf(mpPaceHigh), 1, 0, 0)
	}
	return w
}

// ─────────────────────────────────────────────────────────────────────────────
// map helpers
// ─────────────────────────────────────────────────────────────────────────────

func strAny(v any) string {
	switch t := v.(type) {
	case string:
		return t
	case float64:
		return strconv.FormatFloat(t, 'f', -1, 64)
	case float32:
		return strconv.FormatFloat(float64(t), 'f', -1, 64)
	case int:
		return strconv.Itoa(t)
	case int64:
		return strconv.FormatInt(t, 10)
	case json.Number:
		return t.String()
	case nil:
		return ""
	default:
		return fmt.Sprint(t)
	}
}

func intAny(v any) int {
	switch t := v.(type) {
	case float64:
		return int(t)
	case float32:
		return int(t)
	case int:
		return t
	case int64:
		return int(t)
	case string:
		n, _ := strconv.Atoi(t)
		return n
	case json.Number:
		n, _ := t.Int64()
		return int(n)
	default:
		return 0
	}
}

func floatAny(v any) float64 {
	switch t := v.(type) {
	case float64:
		return t
	case float32:
		return float64(t)
	case int:
		return float64(t)
	case int64:
		return float64(t)
	case string:
		f, _ := strconv.ParseFloat(t, 64)
		return f
	case json.Number:
		f, _ := t.Float64()
		return f
	default:
		return 0
	}
}

func firstNonEmpty(m map[string]any, keys ...string) string {
	for _, k := range keys {
		if v, ok := m[k]; ok {
			if s := strAny(v); s != "" {
				return s
			}
		}
	}
	return ""
}

func pickAny(m map[string]any, keys ...any) any {
	// keys are (key, key, ..., default); the first present key wins, else default.
	if len(keys) < 2 {
		return nil
	}
	for _, k := range keys[:len(keys)-1] {
		if v, ok := m[k.(string)]; ok {
			return v
		}
	}
	return keys[len(keys)-1]
}

func cloneMap(m map[string]any) map[string]any {
	out := make(map[string]any, len(m))
	for k, v := range m {
		out[k] = v
	}
	return out
}

func setDefault(m map[string]any, key string, val any) {
	if _, ok := m[key]; !ok {
		m[key] = val
	}
}

func floatPtrOf(v float64) *float64 { return &v }

func stringPtrOf(s string) *string { return &s }
