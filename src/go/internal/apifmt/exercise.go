// exercise.go ports the COROS exercise T-code → display-name mapping and the
// segment-naming rule the activity-detail serializer applies to strength/type2
// laps. Sources:
//
//   - exerciseNames ← stride_server.deps.EXERCISE_NAMES (display-layer data)
//   - exerciseTypes ← stride_core.models.EXERCISE_TYPES
//   - SegmentName   ← the 3-branch seg_name derivation in
//     stride_server/routes/activities.py::build_activity_detail
package apifmt

import (
	"strings"
	"unicode"
)

// exerciseNames maps a COROS exercise T-code to its Chinese display name. Kept
// here (not in a domain package) because it is display-layer data, matching the
// Python placement in stride_server.deps.
var exerciseNames = map[string]string{
	"T1001": "搏击操", "T1002": "引体向上", "T1004": "俯卧撑", "T1005": "跳绳",
	"T1006": "仰卧起坐", "T1007": "波比跳", "T1009": "开合跳", "T1010": "平板支撑",
	"T1011": "哑铃体侧屈", "T1013": "高抬腿", "T1014": "跳箱", "T1035": "仰卧举腿",
	"T1076": "自行车卷腹", "T1079": "登山跑", "T1106": "弹力带反向飞鸟",
	"T1120": "热身", "T1121": "训练", "T1122": "放松", "T1123": "休息",
	"T1145": "俄罗斯转体", "T1150": "鸟狗式", "T1185": "侧平板",
	"T1243": "死虫式", "T1320": "弹力带肩外旋", "T1324": "弹力带肩推",
	"T1364": "药球俄罗斯转体", "T1368": "哥本哈根侧平板",
	"T1384": "泡沫轴-髋部", "T1385": "泡沫轴-腘绳肌",
	"T1386": "泡沫轴-髂胫束", "T1387": "泡沫轴-股四头肌", "T1389": "泡沫轴-小腿",
	"S3618": "休息",
}

// exerciseTypes maps a COROS exercise_type integer to its phase name. The
// serializer falls back to "训练" for an unknown/zero type.
var exerciseTypes = map[int]string{
	1: "热身",
	2: "训练",
	3: "放松",
	4: "恢复",
}

// SegmentName resolves a type2 lap's display name, mirroring the Python
// build_activity_detail rule exactly:
//
//  1. a non-empty name key present in EXERCISE_NAMES → its mapped name;
//  2. else a name key with the "sid_strength_" prefix → the remainder with
//     underscores spaced and title-cased (Python str.title());
//  3. else EXERCISE_TYPES[exercise_type or 0], defaulting to "训练".
func SegmentName(exerciseNameKey *string, exerciseType *int) string {
	if exerciseNameKey != nil && *exerciseNameKey != "" {
		key := *exerciseNameKey
		if name, ok := exerciseNames[key]; ok {
			return name
		}
		if strings.HasPrefix(key, "sid_strength_") {
			cleaned := strings.ReplaceAll(strings.TrimPrefix(key, "sid_strength_"), "_", " ")
			return pythonTitle(cleaned)
		}
	}
	et := 0
	if exerciseType != nil {
		et = *exerciseType
	}
	if name, ok := exerciseTypes[et]; ok {
		return name
	}
	return "训练"
}

// pythonTitle reproduces Python str.title(): the first letter of each maximal
// run of letters is upper-cased and the rest lower-cased; non-letters are word
// boundaries (so a letter following a digit or space starts a new word).
func pythonTitle(s string) string {
	var b strings.Builder
	b.Grow(len(s))
	prevLetter := false
	for _, r := range s {
		if unicode.IsLetter(r) {
			if prevLetter {
				b.WriteRune(unicode.ToLower(r))
			} else {
				b.WriteRune(unicode.ToUpper(r))
			}
			prevLetter = true
		} else {
			b.WriteRune(r)
			prevLetter = false
		}
	}
	return b.String()
}
