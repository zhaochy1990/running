package competitioncalendar

import "strings"

// usStateNames maps 2-letter US state codes to their English full names, used
// as the English province for US races (the upstream venue carries the code).
var usStateNames = map[string]string{
	"AL": "Alabama", "AK": "Alaska", "AZ": "Arizona", "AR": "Arkansas",
	"CA": "California", "CO": "Colorado", "CT": "Connecticut", "DC": "District of Columbia",
	"DE": "Delaware", "FL": "Florida", "GA": "Georgia", "HI": "Hawaii",
	"ID": "Idaho", "IL": "Illinois", "IN": "Indiana", "IA": "Iowa",
	"KS": "Kansas", "KY": "Kentucky", "LA": "Louisiana", "ME": "Maine",
	"MD": "Maryland", "MA": "Massachusetts", "MI": "Michigan", "MN": "Minnesota",
	"MS": "Mississippi", "MO": "Missouri", "MT": "Montana", "NE": "Nebraska",
	"NV": "Nevada", "NH": "New Hampshire", "NJ": "New Jersey", "NM": "New Mexico",
	"NY": "New York", "NC": "North Carolina", "ND": "North Dakota", "OH": "Ohio",
	"OK": "Oklahoma", "OR": "Oregon", "PA": "Pennsylvania", "RI": "Rhode Island",
	"SC": "South Carolina", "SD": "South Dakota", "TN": "Tennessee", "TX": "Texas",
	"UT": "Utah", "VT": "Vermont", "VA": "Virginia", "WA": "Washington",
	"WV": "West Virginia", "WI": "Wisconsin", "WY": "Wyoming",
}

// chinaCity maps the upstream English city name to its Chinese name (with
// administrative suffix) and Chinese province for Chinese races. Kept in the
// handler because it is source-specific curation; extend as new cities appear.
// Province uses the standard 省/直辖市/自治区/特别行政区 names.
//
// City MUST be the prefecture level (地级市 / 直辖市 / 自治州), never a district,
// county or county-level city. The upstream venue string frequently names the
// host locality instead — "Gaochun" for 高淳区, "Zhenning" for 镇宁县 — but the
// 中国田协 catalogue splits raceAddress and discards its third segment, so that
// side's city is always the prefecture. Leaving a district here makes the two
// sources disagree on the city of the same race, which breaks the
// (race_date, city) join the race_calendar_wa_label step matches on: before this
// rule, 高淳/浦口/西昌/杨陵/镇宁 matched nothing and their races silently lost
// their World Athletics tier. The race's own name carries the locality anyway.
//
// (Yiwu is the one county-level city that stays: no 金华 race exists in the
// 中国田协 catalogue to join against, so the prefecture would cost precision for
// nothing. Revisit it if one appears.)
type chinaCityEntry struct {
	CityZh   string
	Province string
}

var chinaCity = map[string]chinaCityEntry{
	"Beijing":       {"北京市", "北京市"},
	"Changzhou":     {"常州市", "江苏省"},
	"Chengdu":       {"成都市", "四川省"},
	"Chongqing":     {"重庆市", "重庆市"},
	"Dalian":        {"大连市", "辽宁省"},
	"Dongying":      {"东营市", "山东省"},
	"Fangchenggang": {"防城港市", "广西壮族自治区"},
	"Fuzhou":        {"福州市", "福建省"},
	"Gaochun":       {"南京市", "江苏省"},
	"Guangzhou":     {"广州市", "广东省"},
	"Guilin":        {"桂林市", "广西壮族自治区"},
	"Guiyang":       {"贵阳市", "贵州省"},
	"Hangzhou":      {"杭州市", "浙江省"},
	"Harbin":        {"哈尔滨市", "黑龙江省"},
	"Huai'an":       {"淮安市", "江苏省"},
	"Huangshi":      {"黄石市", "湖北省"},
	"Jilin":         {"吉林市", "吉林省"},
	"Lanzhou":       {"兰州市", "甘肃省"},
	"Meishan":       {"眉山市", "四川省"},
	"Nanchang":      {"南昌市", "江西省"},
	"Nanjing":       {"南京市", "江苏省"},
	"Nanning":       {"南宁市", "广西壮族自治区"},
	"Pukou":         {"南京市", "江苏省"},
	"Qingdao":       {"青岛市", "山东省"},
	"Shanghai":      {"上海市", "上海市"},
	"Shenyang":      {"沈阳市", "辽宁省"},
	"Shenzhen":      {"深圳市", "广东省"},
	"Shijiazhuang":  {"石家庄市", "河北省"},
	"Suzhou":        {"苏州市", "江苏省"},
	"Taiyuan":       {"太原市", "山西省"},
	"Wuhan":         {"武汉市", "湖北省"},
	"Wuxi":          {"无锡市", "江苏省"},
	"Xi'an":         {"西安市", "陕西省"},
	"Xiamen":        {"厦门市", "福建省"},
	"Xichang":       {"凉山彝族自治州", "四川省"},
	"Xinyu":         {"新余市", "江西省"},
	"Yancheng":      {"盐城市", "江苏省"},
	"Yangling":      {"咸阳市", "陕西省"},
	"Yangzhou":      {"扬州市", "江苏省"},
	"Yichang":       {"宜昌市", "湖北省"},
	"Yiwu":          {"义乌市", "浙江省"},
	"Zhenning":      {"安顺市", "贵州省"},
}

// parseLocation derives (province, city) from the upstream venue string and
// country code. Venue formats observed:
//
//	"Xiamen (CHN)"                                  -> city Xiamen
//	"Houston, TX (USA)"                             -> city Houston, state TX
//	"Home Depot Backyard, Atlanta, GA (USA)"        -> city Atlanta, state GA
//	"Green Point Stadium, Cape Town (RSA)"          -> city Cape Town
//
// The trailing "(CCC)" is stripped, then the last comma-separated segment is
// the city — except when it is a 2-letter US state code, in which case the
// segment before it is the city and the code maps to the English state name.
// Chinese cities are then replaced with their Chinese name + province; foreign
// cities keep the upstream English name, and province stays empty when the
// venue carried no state (most non-US races).
func parseLocation(venue, country string) (province, city string) {
	inner := strings.TrimSpace(venue)
	if i := strings.LastIndex(inner, "("); i >= 0 {
		inner = strings.TrimSpace(inner[:i])
	}
	if inner == "" {
		return "", ""
	}

	parts := strings.Split(inner, ",")
	last := strings.TrimSpace(parts[len(parts)-1])
	// Only US venues get the state-code branch: foreign 2-letter suffixes (e.g.
	// Italian province codes) must never be mistaken for a US state.
	if len(parts) >= 2 && country == "USA" {
		if state, ok := usStateNames[last]; ok {
			return state, strings.TrimSpace(parts[len(parts)-2])
		}
	}
	city = last

	if country == "CHN" {
		if e, ok := chinaCity[city]; ok {
			return e.Province, e.CityZh
		}
	}
	return "", city
}
