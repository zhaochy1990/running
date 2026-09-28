// name.go extracts the city from watch-generated activity names. COROS names
// activities "<城市> <运动类型>" ("上海市 跑步", "昆明市 越野跑", "上海市 运动场跑步");
// the prefix is device reverse-geocoded at recording time, so it survives for
// historical activities whose GPS start fix was never cached. Garmin does not
// use this naming, so for Garmin-heavy users the GPS signal carries the vote.
package homecity

import "regexp"

// cityHintPattern matches a leading administrative name ending in 市. The
// 2–10 hanzi bound admits prefecture names like "西双版纳州" style lengths for
// 市-suffixed names ("乌鲁木齐市") while rejecting free-text note prefixes that
// merely start with Chinese characters. Anchors and this parser share the
// "<名称>市" naming so votes from both sources aggregate on the same key.
var cityHintPattern = regexp.MustCompile(`^([\p{Han}]{2,10}市)(\s|$)`)

// ParseCityHint returns the city prefix of a watch-generated activity name.
// Names without a leading "…市" token (Garmin's "晨跑", user notes, empty)
// return ok=false.
func ParseCityHint(name *string) (string, bool) {
	if name == nil || *name == "" {
		return "", false
	}
	match := cityHintPattern.FindStringSubmatch(*name)
	if match == nil {
		return "", false
	}
	return match[1], true
}
