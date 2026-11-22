package normalize

import "encoding/json"

// PauseInterval contains absolute watch timestamps in centiseconds.
type PauseInterval struct {
	Start int64
	End   int64
}

// ParsePauseIntervals reads both current COROS and legacy pause records.
func ParsePauseIntervals(raw *string) ([]PauseInterval, error) {
	if raw == nil || *raw == "" {
		return nil, nil
	}
	var stored []struct {
		StartTimestamp *int64 `json:"startTimestamp"`
		EndTimestamp   *int64 `json:"endTimestamp"`
		StartTS        *int64 `json:"start_ts"`
		EndTS          *int64 `json:"end_ts"`
	}
	if err := json.Unmarshal([]byte(*raw), &stored); err != nil {
		return nil, err
	}
	var intervals []PauseInterval
	for _, pause := range stored {
		start, end := pause.StartTimestamp, pause.EndTimestamp
		if start == nil {
			start = pause.StartTS
		}
		if end == nil {
			end = pause.EndTS
		}
		if start != nil && end != nil && *end > *start {
			intervals = append(intervals, PauseInterval{Start: *start, End: *end})
		}
	}
	return intervals, nil
}
