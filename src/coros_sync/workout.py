"""Build and push running and strength training workouts to COROS Training Hub.

Running workout structure (reverse-engineered from COROS Training Hub):
- exerciseType: 1=warm-up, 2=training, 3=cool-down
- targetType: 2=time(seconds), 5=distance(mm)
- intensityType: 0=no pace target, 3=pace target
- intensityValue/intensityValueExtend: pace range in ms/km (e.g. 300000=5:00/km)
- sportType: 1=running

Strength workout structure:
- sportType: 4=strength
- exercises are full objects from the COROS exercise library (via client.query_exercises())
- targetType: 2=time(seconds), 3=reps
- Each exercise carries originId (library id) plus a sequential id counter

Schedule is pushed via POST /training/schedule/update with:
- entities[]: date + bar chart visualization
- programs[]: full workout definition with exercises
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from .client import CorosClient

# Exercise codes for running workouts
WARMUP_TIME = {"name": "T1120", "originId": "425895398452936705", "overview": "sid_run_warm_up_dist",
               "createTimestamp": 1586584068, "defaultOrder": 1}
WARMUP_DIST = {"name": "T1121", "originId": "425895427796307968", "overview": "sid_run_warm_up_time",
               "createTimestamp": 1586584140, "defaultOrder": 1}
TRAINING = {"name": "T3001", "originId": "426109589008859136", "overview": "sid_run_training",
            "createTimestamp": 1587381919, "defaultOrder": 2}
COOLDOWN_TIME = {"name": "T1122", "originId": "425895456971866112", "overview": "sid_run_cool_down_dist",
                 "createTimestamp": 1586584214, "defaultOrder": 3}
RECOVERY = {"name": "T1123", "originId": "425895398452936705", "overview": "sid_run_cool_down_dist",
            "createTimestamp": 1586584214, "defaultOrder": 3}

# Source images for running workout types
SOURCE_URLS = {
    "easy": "https://oss.coros.com/source/source_default/0/37a30375849b49f89cbd5ab80eec5c7e.jpg",
    "tempo": "https://oss.coros.com/source/source_default/0/8f65f771b129460abce14d3376a39d83.jpg",
    "interval": "https://oss.coros.com/source/source_default/0/2fbd46e17bc54bc5873415c9fa767bdc.jpg",
    "long": "https://oss.coros.com/source/source_default/0/8f65f771b129460abce14d3376a39d83.jpg",
}


def pace_to_ms(pace_str: str) -> int:
    """Convert pace string like '5:30' (min:sec per km) to milliseconds per km."""
    parts = pace_str.split(":")
    minutes = int(parts[0])
    seconds = int(parts[1]) if len(parts) > 1 else 0
    return (minutes * 60 + seconds) * 1000


def _make_exercise(
    exercise_type: int,  # 1=warmup, 2=training, 3=cooldown
    sort_no: int,
    target_type: int,  # 2=time(s), 5=distance(mm)
    target_value: int,
    template: dict,
    pace_low: str | None = None,  # slower pace e.g. "5:40"
    pace_high: str | None = None,  # faster pace e.g. "5:20"
    sets: int = 1,
) -> dict:
    exercise: dict[str, Any] = {
        "access": 0,
        "createTimestamp": template["createTimestamp"],
        "defaultOrder": template["defaultOrder"],
        "equipment": [1],
        "exerciseType": exercise_type,
        "groupId": "",
        "hrType": 0,
        "id": sort_no,
        "intensityCustom": 0,
        "intensityDisplayUnit": 0,
        "intensityMultiplier": 0,
        "intensityPercent": 0,
        "intensityPercentExtend": 0,
        "intensityType": 0,
        "intensityValue": 0,
        "intensityValueExtend": 0,
        "isDefaultAdd": 0 if exercise_type != 2 else 1,
        "isGroup": False,
        "isIntensityPercent": False,
        "name": template["name"],
        "originId": template["originId"],
        "overview": template["overview"],
        "part": [0],
        "restType": 3,
        "restValue": 0,
        "sets": sets,
        "sortNo": sort_no,
        "sourceId": "0",
        "sourceUrl": "",
        "sportType": 1,
        "subType": 0,
        "targetDisplayUnit": 1 if target_type == 5 else 0,
        "targetType": target_type,
        "targetValue": target_value,
        "userId": 0,
        "videoUrl": "",
    }

    if pace_low and pace_high:
        exercise["intensityType"] = 3
        exercise["intensityValue"] = pace_to_ms(pace_low)
        exercise["intensityValueExtend"] = pace_to_ms(pace_high)
        exercise["intensityDisplayUnit"] = "1"
        exercise["intensityMultiplier"] = 1000
        # intensityPercent is derived from pace relative to threshold
        # Approximate: pace_ms / threshold_pace_ms * 100 * 1000
        exercise["intensityPercent"] = exercise["intensityValue"] // 5
        exercise["intensityPercentExtend"] = exercise["intensityValueExtend"] // 5

    return exercise


@dataclass
class RunSegment:
    """A segment of a running workout."""
    segment_type: str  # "warmup", "training", "cooldown", "recovery", "interval"
    distance_km: float | None = None  # distance in km
    duration_min: float | None = None  # duration in minutes
    pace_low: str | None = None  # slower pace "5:40"
    pace_high: str | None = None  # faster pace "5:20"
    sets: int = 1
    rest_type: int = 0  # 0=none, 2=time(seconds), 5=distance(mm)
    rest_value: int = 0  # rest duration in seconds or distance in mm
    # Interval group: recovery between reps
    recovery_duration_s: int = 0  # recovery time in seconds between reps


@dataclass
class RunWorkout:
    """A complete running workout to push to COROS."""
    name: str
    date: str  # YYYYMMDD
    segments: list[RunSegment] = field(default_factory=list)
    workout_type: str = "easy"  # easy, tempo, interval, long

    def add_warmup(
        self,
        duration_min: float | None = None,
        distance_km: float | None = None,
        pace_low: str | None = None,
        pace_high: str | None = None,
    ) -> RunWorkout:
        if duration_min is None and distance_km is None:
            duration_min = 5
        self.segments.append(RunSegment(
            "warmup", duration_min=duration_min, distance_km=distance_km,
            pace_low=pace_low, pace_high=pace_high,
        ))
        return self

    def add_training(
        self,
        distance_km: float | None = None,
        duration_min: float | None = None,
        pace_low: str | None = None,
        pace_high: str | None = None,
        sets: int = 1,
        rest_type: int = 0,
        rest_value: int = 0,
    ) -> RunWorkout:
        self.segments.append(RunSegment(
            "training", distance_km=distance_km, duration_min=duration_min,
            pace_low=pace_low, pace_high=pace_high, sets=sets,
            rest_type=rest_type, rest_value=rest_value,
        ))
        return self

    def add_recovery(
        self,
        duration_min: float | None = None,
        distance_km: float | None = None,
        pace_low: str | None = None,
        pace_high: str | None = None,
    ) -> RunWorkout:
        """Add a recovery jog segment (exerciseType=3)."""
        if duration_min is None and distance_km is None:
            duration_min = 3
        self.segments.append(RunSegment(
            "recovery", duration_min=duration_min, distance_km=distance_km,
            pace_low=pace_low, pace_high=pace_high,
        ))
        return self

    def add_interval(
        self,
        sets: int,
        distance_km: float | None = None,
        duration_min: float | None = None,
        pace_low: str | None = None,
        pace_high: str | None = None,
        recovery_duration_s: int = 60,
    ) -> RunWorkout:
        """Add an interval group: N reps of work + recovery in COROS format.

        Creates a group container (exerciseType=0) with training (exerciseType=2)
        and recovery (exerciseType=4) children.
        """
        self.segments.append(RunSegment(
            "interval", distance_km=distance_km, duration_min=duration_min,
            pace_low=pace_low, pace_high=pace_high, sets=sets,
            recovery_duration_s=recovery_duration_s,
        ))
        return self

    def add_cooldown(
        self,
        duration_min: float | None = None,
        distance_km: float | None = None,
        pace_low: str | None = None,
        pace_high: str | None = None,
    ) -> RunWorkout:
        if duration_min is None and distance_km is None:
            duration_min = 5
        self.segments.append(RunSegment(
            "cooldown", duration_min=duration_min, distance_km=distance_km,
            pace_low=pace_low, pace_high=pace_high,
        ))
        return self

    def _build_exercises(self) -> list[dict]:
        exercises = []
        sort_no = 0
        next_id = 0  # unique id counter across all exercises
        for seg in self.segments:
            sort_no += 1
            next_id += 1

            if seg.segment_type == "interval":
                # COROS interval group format:
                # 1. Group container (exerciseType=0, isGroup=true, sets=N)
                # 2. Training exercise (exerciseType=2, groupId=group_id)
                # 3. Recovery exercise (exerciseType=4, groupId=group_id)
                group_id = next_id
                group = {
                    "access": 0, "defaultOrder": 0, "exerciseType": 0,
                    "id": group_id, "intensityCustom": 0, "intensityMultiplier": 0,
                    "intensityType": 0, "intensityValue": 0, "intensityValueExtend": 0,
                    "isDefaultAdd": 0, "isGroup": True, "name": "", "originId": "",
                    "overview": "", "programId": "", "restType": 0,
                    "restValue": seg.recovery_duration_s, "sets": seg.sets,
                    "sortNo": sort_no, "sourceId": "0", "sourceUrl": "",
                    "sportType": 0, "subType": 0, "targetType": "", "targetValue": 0,
                    "videoUrl": "",
                }
                exercises.append(group)

                # Training interval (sortNo same as group, unique id)
                next_id += 1
                if seg.distance_km:
                    target_type = 5
                    target_value = int(seg.distance_km * 100_000)
                else:
                    target_type = 2
                    target_value = int((seg.duration_min or 5) * 60)
                training_ex = _make_exercise(
                    2, sort_no, target_type, target_value, TRAINING,
                    pace_low=seg.pace_low, pace_high=seg.pace_high,
                )
                training_ex["id"] = next_id
                training_ex["groupId"] = group_id
                exercises.append(training_ex)

                # Recovery between reps (next sortNo, unique id)
                sort_no += 1
                next_id += 1
                recovery_ex = _make_exercise(
                    4, sort_no, 2, seg.recovery_duration_s, RECOVERY,
                )
                recovery_ex["id"] = next_id
                recovery_ex["groupId"] = group_id
                exercises.append(recovery_ex)
                continue

            if seg.segment_type == "warmup":
                ex_type = 1
                if seg.distance_km:
                    target_type = 5
                    target_value = int(seg.distance_km * 100_000)
                    template = WARMUP_DIST
                else:
                    target_type = 2
                    target_value = int((seg.duration_min or 5) * 60)
                    template = WARMUP_TIME
            elif seg.segment_type == "recovery":
                ex_type = 4
                if seg.distance_km:
                    target_type = 5
                    target_value = int(seg.distance_km * 100_000)
                else:
                    target_type = 2
                    target_value = int((seg.duration_min or 3) * 60)
                template = RECOVERY
            elif seg.segment_type == "cooldown":
                ex_type = 3
                if seg.distance_km:
                    target_type = 5
                    target_value = int(seg.distance_km * 100_000)
                else:
                    target_type = 2
                    target_value = int((seg.duration_min or 5) * 60)
                template = COOLDOWN_TIME
            else:  # training
                if seg.distance_km:
                    target_type = 5
                    target_value = int(seg.distance_km * 100_000)
                else:
                    target_type = 2
                    target_value = int((seg.duration_min or 30) * 60)
                template = TRAINING
                ex_type = 2

            ex = _make_exercise(
                ex_type, sort_no, target_type, target_value, template,
                pace_low=seg.pace_low, pace_high=seg.pace_high, sets=seg.sets,
            )
            ex["id"] = next_id
            exercises.append(ex)
        return exercises

    def _build_bar_chart(self, exercises: list[dict]) -> list[dict]:
        """Build the exerciseBarChart visualization data."""
        # Calculate total value for width percentages
        values = []
        for ex in exercises:
            if ex["targetType"] == 5:  # distance
                values.append(ex["targetValue"] / 1000)  # mm to m-ish for ratio
            else:
                values.append(ex["targetValue"])
        total = sum(values) or 1

        chart = []
        for ex, val in zip(exercises, values):
            width = round(val / total * 100, 2)
            height = 5 if ex["exerciseType"] != 2 else 65
            chart.append({
                "exerciseId": str(ex["id"]),
                "exerciseType": ex["exerciseType"],
                "height": height,
                "name": ex["name"],
                "targetType": ex["targetType"],
                "targetValue": ex["targetValue"],
                "value": val,
                "width": width,
                "widthFill": 0,
            })
        return chart

    def build_payload(self, id_in_plan: int = 0) -> dict:
        """Build the full /training/schedule/update payload."""
        exercises = self._build_exercises()
        bar_chart = self._build_bar_chart(exercises)
        total_sets = sum(ex["sets"] for ex in exercises)

        source_url = SOURCE_URLS.get(self.workout_type, SOURCE_URLS["easy"])

        program = {
            "access": 1,
            "authorId": "0",
            "createTimestamp": 0,
            "distance": 0,
            "duration": 0,
            "essence": 0,
            "estimatedType": 0,
            "estimatedValue": 0,
            "exerciseNum": 0,
            "exercises": exercises,
            "headPic": "",
            "id": "0",
            "idInPlan": id_in_plan,
            "name": self.name,
            "nickname": "",
            "originEssence": 0,
            "overview": "",
            "pbVersion": 2,
            "planIdIndex": 0,
            "poolLength": 2500,
            "profile": "",
            "referExercise": {"intensityType": 0, "hrType": 0, "valueType": 0},
            "sex": 0,
            "shareUrl": "",
            "simple": False,
            "sourceUrl": source_url,
            "sportType": 1,
            "star": 0,
            "subType": 65535,
            "targetType": 0,
            "targetValue": 0,
            "thirdPartyId": 0,
            "totalSets": total_sets,
            "trainingLoad": 0,
            "type": 0,
            "unit": 0,
            "userId": "0",
            "version": 0,
            "videoCoverUrl": "",
            "videoUrl": "",
            "fastIntensityTypeName": "custom",
            "poolLengthId": 1,
            "poolLengthUnit": 2,
            "sourceId": "425868125142171648",
        }

        entity = {
            "happenDay": self.date,
            "idInPlan": id_in_plan,
            "sortNo": 0,
            "dayNo": 0,
            "sortNoInPlan": 0,
            "sortNoInSchedule": 0,
            "exerciseBarChart": bar_chart,
        }

        return {
            "entities": [entity],
            "programs": [program],
            "versionObjects": [{"id": id_in_plan, "status": 1}],
            "pbVersion": 2,
        }


def _get_next_id_in_plan(client: CorosClient, date: str) -> tuple[int, int]:
    """Query schedule to get next available idInPlan and the current pbVersion.
    Returns (next_id_in_plan, pb_version)."""
    # Query a wide range around the target date
    start = date[:6] + "01"  # First of month
    # End = start + 2 months
    month = int(date[4:6])
    year = int(date[:4])
    end_month = month + 2
    end_year = year
    if end_month > 12:
        end_month -= 12
        end_year += 1
    end = f"{end_year}{end_month:02d}28"

    data = client.query_schedule(start, end)
    schedule = data.get("data", {})
    max_id = int(schedule.get("maxIdInPlan", "0") or "0")
    pb_version = schedule.get("pbVersion", 2)
    return max_id + 1, pb_version


def push_workout(client: CorosClient, workout: RunWorkout) -> dict:
    """Calculate and push a workout to the COROS training schedule."""
    # Get next available idInPlan from existing schedule
    next_id, pb_version = _get_next_id_in_plan(client, workout.date)

    # Build payload with correct idInPlan
    payload = workout.build_payload(id_in_plan=next_id)
    program = payload["programs"][0]
    entity = payload["entities"][0]

    # Calculate to get distance/duration/trainingLoad
    calc = client.calculate_workout(program, entity)
    calc_data = calc.get("data", {})

    # Apply calculated values back to program
    program["distance"] = calc_data.get("planDistance", calc_data.get("distance", "0"))
    program["duration"] = calc_data.get("planDuration", calc_data.get("duration", 0))
    program["trainingLoad"] = calc_data.get("planTrainingLoad", calc_data.get("trainingLoad", 0))
    program["totalSets"] = calc_data.get("planSets", calc_data.get("sets", program["totalSets"]))
    program["sets"] = program["totalSets"]
    program["pitch"] = calc_data.get("planPitch", calc_data.get("pitch", 0))
    if "distanceDisplayUnit" in calc_data:
        program["distanceDisplayUnit"] = calc_data["distanceDisplayUnit"]
    # Use bar chart from calculate response (has correct widths)
    if "exerciseBarChart" in calc_data:
        program["exerciseBarChart"] = calc_data["exerciseBarChart"]
        entity["exerciseBarChart"] = calc_data["exerciseBarChart"]

    # Push to schedule
    return client.update_schedule(
        entities=[entity],
        programs=[program],
        version_objects=payload["versionObjects"],
        pb_version=pb_version,
    )


# --- Convenience builders for common workout types ---

def easy_run(date: str, distance_km: float, pace_low: str = "5:40", pace_high: str = "5:20") -> RunWorkout:
    """Easy aerobic run."""
    return (RunWorkout(f"Easy Run {distance_km}km", date, workout_type="easy")
            .add_warmup(5)
            .add_training(distance_km=distance_km, pace_low=pace_low, pace_high=pace_high)
            .add_cooldown(5))


def tempo_run(
    date: str, warmup_min: float, tempo_km: float, pace_low: str, pace_high: str,
    warmup_km: float | None = None, warmup_pace_low: str | None = None, warmup_pace_high: str | None = None,
    cooldown_km: float | None = None, cooldown_pace_low: str | None = None, cooldown_pace_high: str | None = None,
) -> RunWorkout:
    """Tempo/threshold run."""
    w = RunWorkout(f"Tempo {tempo_km}km @ {pace_high}", date, workout_type="tempo")
    if warmup_km:
        w.add_warmup(distance_km=warmup_km, pace_low=warmup_pace_low, pace_high=warmup_pace_high)
    else:
        w.add_warmup(duration_min=warmup_min)
    w.add_training(distance_km=tempo_km, pace_low=pace_low, pace_high=pace_high)
    if cooldown_km:
        w.add_cooldown(distance_km=cooldown_km, pace_low=cooldown_pace_low, pace_high=cooldown_pace_high)
    else:
        w.add_cooldown()
    return w


def interval_run(
    date: str, warmup_min: float, reps: int, interval_m: int,
    pace_low: str, pace_high: str, recovery_min: float = 3,
    warmup_km: float | None = None, warmup_pace_low: str | None = None, warmup_pace_high: str | None = None,
    cooldown_km: float | None = None, cooldown_pace_low: str | None = None, cooldown_pace_high: str | None = None,
) -> RunWorkout:
    """Interval workout with repeats using COROS group format."""
    w = RunWorkout(f"{reps}x{interval_m}m Intervals", date, workout_type="interval")
    if warmup_km:
        w.add_warmup(distance_km=warmup_km, pace_low=warmup_pace_low, pace_high=warmup_pace_high)
    else:
        w.add_warmup(duration_min=warmup_min)
    w.add_interval(
        sets=reps, distance_km=interval_m / 1000,
        pace_low=pace_low, pace_high=pace_high,
        recovery_duration_s=int(recovery_min * 60),
    )
    if cooldown_km:
        w.add_cooldown(distance_km=cooldown_km, pace_low=cooldown_pace_low, pace_high=cooldown_pace_high)
    else:
        w.add_cooldown()
    return w


def long_run(date: str, total_km: float, easy_km: float, mp_km: float,
             easy_pace_low: str = "5:20", easy_pace_high: str = "5:00",
             mp_pace_low: str = "4:10", mp_pace_high: str = "4:00") -> RunWorkout:
    """Long run with marathon pace finish."""
    w = RunWorkout(f"Long Run {total_km}km", date, workout_type="long")
    w.add_warmup(5)
    w.add_training(distance_km=easy_km, pace_low=easy_pace_low, pace_high=easy_pace_high)
    if mp_km > 0:
        w.add_training(distance_km=mp_km, pace_low=mp_pace_low, pace_high=mp_pace_high)
    w.add_cooldown(5)
    return w


# --- Strength training support ---

# Source image constants for strength workouts
STRENGTH_SOURCE_URL = "https://oss.coros.com/source/source_default/0/8f65f771b129460abce14d3376a39d83.jpg"
STRENGTH_SOURCE_ID = "425846071290413056"


@dataclass
class StrengthExercise:
    """A single exercise in a strength workout."""

    exercise_data: dict  # Full exercise object from query_exercises()
    sets: int = 3
    target_type: int = 3  # 2=time(seconds), 3=reps
    target_value: int = 12  # reps or seconds depending on target_type
    rest_type: int = 1  # 1=time-based rest
    rest_value: int = 60  # seconds of rest between sets


@dataclass
class StrengthWorkout:
    """A strength training workout to push to COROS."""

    name: str
    date: str  # YYYYMMDD
    exercises: list[StrengthExercise] = field(default_factory=list)

    def add_exercise(
        self,
        exercise_data: dict,
        sets: int = 3,
        target_type: int | None = None,
        target_value: int | None = None,
        rest_value: int = 60,
    ) -> StrengthWorkout:
        """Add an exercise from the COROS library.

        Args:
            exercise_data: Full exercise dict from client.query_exercises()
            sets: Number of sets
            target_type: 2=time(seconds), 3=reps. Defaults to exercise's default.
            target_value: Target reps or seconds. Defaults to exercise's default.
            rest_value: Rest between sets in seconds.
        """
        self.exercises.append(StrengthExercise(
            exercise_data=exercise_data,
            sets=sets,
            target_type=target_type if target_type is not None else exercise_data.get("targetType", 3),
            target_value=target_value if target_value is not None else exercise_data.get("targetValue", 12),
            rest_value=rest_value,
        ))
        return self

    def _build_exercises(self) -> list[dict]:
        exercises = []
        for i, ex in enumerate(self.exercises):
            exercise = dict(ex.exercise_data)  # Copy full exercise data from library
            exercise["originId"] = str(exercise["id"])  # Library ID becomes originId
            exercise["id"] = i + 1  # Sequential counter
            exercise["sortNo"] = i
            exercise["sets"] = ex.sets
            exercise["targetType"] = ex.target_type
            exercise["targetValue"] = ex.target_value
            exercise["restType"] = ex.rest_type
            exercise["restValue"] = ex.rest_value
            exercise["groupId"] = ""
            # Ensure these fields exist
            exercise.setdefault("hrType", 0)
            exercise.setdefault("intensityValueExtend", 0)
            exercise.setdefault("intensityMultiplier", 0)
            exercise.setdefault("intensityPercent", 0)
            exercise.setdefault("intensityPercentExtend", 0)
            exercise.setdefault("intensityDisplayUnit", "6")
            exercise.setdefault("targetDisplayUnit", 0)
            exercises.append(exercise)
        return exercises

    def build_payload(self, id_in_plan: int = 0) -> dict:
        """Build the full /training/schedule/update payload for a strength workout."""
        exercises_list = self._build_exercises()
        total_sets = sum(ex.sets for ex in self.exercises)

        program = {
            "access": 1, "authorId": "0", "createTimestamp": 0,
            "distance": 0, "duration": 0, "essence": 0,
            "estimatedType": 0, "estimatedValue": 0, "exerciseNum": 0,
            "exercises": exercises_list,
            "headPic": "", "id": "0", "idInPlan": id_in_plan,
            "name": self.name, "nickname": "",
            "originEssence": 0, "overview": "", "pbVersion": 2,
            "planIdIndex": 0, "poolLength": 2500, "profile": "",
            "referExercise": {"intensityType": 1, "hrType": 0, "valueType": 1},
            "sex": 0, "shareUrl": "", "simple": False,
            "sourceUrl": STRENGTH_SOURCE_URL,
            "sportType": 4, "star": 0, "subType": 65535,
            "targetType": 0, "targetValue": 0, "thirdPartyId": 0,
            "totalSets": total_sets, "trainingLoad": 0,
            "type": 0, "unit": 0, "userId": "0", "version": 0,
            "videoCoverUrl": "", "videoUrl": "",
            "fastIntensityTypeName": "weight",
            "poolLengthId": 1, "poolLengthUnit": 2,
            "sourceId": STRENGTH_SOURCE_ID,
        }

        entity = {
            "happenDay": self.date,
            "idInPlan": id_in_plan,
            "sortNo": 0, "dayNo": 0,
            "sortNoInPlan": 0, "sortNoInSchedule": 0,
        }

        return {
            "entities": [entity],
            "programs": [program],
            "versionObjects": [{"id": id_in_plan, "status": 1}],
            "pbVersion": 2,
        }


def push_strength_workout(client: CorosClient, workout: StrengthWorkout) -> dict:
    """Calculate and push a strength workout to the COROS training schedule."""
    next_id, pb_version = _get_next_id_in_plan(client, workout.date)
    payload = workout.build_payload(id_in_plan=next_id)
    program = payload["programs"][0]
    entity = payload["entities"][0]

    calc = client.calculate_workout(program, entity)
    calc_data = calc.get("data", {})

    program["duration"] = calc_data.get("planDuration", 0)
    program["totalSets"] = calc_data.get("planSets", program["totalSets"])
    program["sets"] = program["totalSets"]
    if "distanceDisplayUnit" in calc_data:
        program["distanceDisplayUnit"] = calc_data["distanceDisplayUnit"]

    return client.update_schedule(
        entities=[entity],
        programs=[program],
        version_objects=payload["versionObjects"],
        pb_version=pb_version,
    )


# --- Convenience builders for common workout types ---

def build_recovery_week(start_date: str) -> list[RunWorkout]:
    """Build this week's recovery plan (Mar 30 - Apr 5)."""
    # Based on the training analysis: recovery week after marathon
    return [
        easy_run(f"{start_date[:6]}01", 8, "6:00", "5:40"),   # Tue Apr 1
        easy_run(f"{start_date[:6]}03", 10, "5:40", "5:30"),  # Thu Apr 3
        easy_run(f"{start_date[:6]}05", 15, "5:30", "5:20"),  # Sat Apr 5
    ]
