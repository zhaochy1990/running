package storage

import (
	"testing"
	"time"
)

func testTime() time.Time { return time.Date(2026, 8, 10, 12, 0, 0, 0, time.UTC) }

func TestValidateInjuryFields(t *testing.T) {
	valid := []struct {
		status, restriction string
	}{
		{InjuryRecoveryActive, RunningRestrictionEasyOnly},
		{InjuryRecoveryActive, RunningRestrictionNoRunning},
		{InjuryRecoveryRecovered, RunningRestrictionNone},
	}
	for _, tc := range valid {
		if got, err := validateInjuryFields("  left knee pain ", tc.status, tc.restriction); err != nil || got != "left knee pain" {
			t.Fatalf("valid injury = %q, %v", got, err)
		}
	}
	invalid := []struct {
		name, description, status, restriction string
	}{
		{"empty", " ", InjuryRecoveryActive, RunningRestrictionEasyOnly},
		{"recovered restricted", "knee", InjuryRecoveryRecovered, RunningRestrictionEasyOnly},
		{"active none", "knee", InjuryRecoveryActive, RunningRestrictionNone},
		{"unknown status", "knee", "other", RunningRestrictionNone},
	}
	for _, tc := range invalid {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := validateInjuryFields(tc.description, tc.status, tc.restriction); err == nil {
				t.Fatal("validation unexpectedly succeeded")
			}
		})
	}
}

func TestInjuryCursorRoundTrip(t *testing.T) {
	cursor := injuryCursor{Active: true, UpdatedAt: testTime(), ID: "11111111-1111-4111-8111-111111111111"}
	encoded, err := encodeInjuryCursor(cursor)
	if err != nil {
		t.Fatal(err)
	}
	got, err := decodeInjuryCursor(encoded)
	if err != nil || got != cursor {
		t.Fatalf("cursor = %+v, %v; want %+v", got, err, cursor)
	}
	if _, err := decodeInjuryCursor("not-a-cursor"); err == nil {
		t.Fatal("malformed cursor unexpectedly accepted")
	}
}
