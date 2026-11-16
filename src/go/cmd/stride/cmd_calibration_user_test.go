package main

import (
	"bytes"
	"testing"
)

// Argument-level guards only: the closed loop itself runs against a real store
// in internal/handlers/compute. These tests pin the operator contract — an
// explicit UUID target and a mandatory authorization actor on every mutating
// action — without touching any database.
func executeCalibrationUser(args ...string) (string, error) {
	root := newRootCmd()
	var output bytes.Buffer
	root.SetOut(&output)
	root.SetErr(&output)
	root.SetArgs(append([]string{"calibration", "user"}, args...))
	err := root.Execute()
	return output.String(), err
}

func TestCalibrationUserCommandRequiresUUIDTarget(t *testing.T) {
	if _, err := executeCalibrationUser("preview"); err == nil {
		t.Fatal("preview without --user must fail")
	}
	if _, err := executeCalibrationUser("preview", "--user", "zhaochaoyi"); err == nil {
		t.Fatal("non-UUID --user must fail (slug aliases are not a valid closed-loop target)")
	}
	if _, err := executeCalibrationUser("preview", "--user", "not-a-uuid"); err == nil {
		t.Fatal("malformed --user must fail")
	}
}

func TestCalibrationUserMutationsRequireActor(t *testing.T) {
	uuid := "11111111-2222-3333-4444-555555555555"
	if _, err := executeCalibrationUser("publish", "--user", uuid); err == nil {
		t.Fatal("publish without --actor must fail (authorization audit)")
	}
	if _, err := executeCalibrationUser("revoke", "--user", uuid); err == nil {
		t.Fatal("revoke without --actor must fail")
	}
	if _, err := executeCalibrationUser("recompute", "--user", uuid, "--actor", "op", "--days", "0"); err == nil {
		t.Fatal("recompute days out of range must fail before any store access")
	}
	if _, err := executeCalibrationUser("recompute", "--user", uuid, "--actor", "op", "--days", "400"); err == nil {
		t.Fatal("recompute days above the cap must fail")
	}
}
