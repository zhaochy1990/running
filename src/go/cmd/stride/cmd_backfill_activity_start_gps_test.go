package main

import (
	"reflect"
	"testing"
)

func TestBackfillActivityStartGPSIsDryRunByDefault(t *testing.T) {
	cmd := newBackfillActivityStartGPSCmd()
	if flag := cmd.Flags().Lookup("commit"); flag == nil || flag.DefValue != "false" {
		t.Fatalf("commit default = %v, want false", flag)
	}
	if flag := cmd.Flags().Lookup("batch-size"); flag == nil || flag.DefValue != "25" {
		t.Fatalf("batch-size default = %v, want 25", flag)
	}
	if flag := cmd.Flags().Lookup("delay"); flag == nil || flag.DefValue != "25ms" {
		t.Fatalf("delay default = %v, want 25ms", flag)
	}
}

func TestBackfillActivityStartGPSRequiresWrapperAllowlist(t *testing.T) {
	t.Setenv("STRIDE_ACTIVITY_START_GPS_REAL_USERS", "")
	cmd := newBackfillActivityStartGPSCmd()
	cmd.SetArgs([]string{"--user", "f10bc353-01ab-4db1-af9f-d9305ea9a532"})
	if err := cmd.Execute(); err == nil {
		t.Fatal("command accepted a missing migration allowlist")
	}
}

func TestSelectActivityStartGPSUsersEnforcesRealUserAllowlist(t *testing.T) {
	allowed := []string{"5ee229a6-cdc1-4260-84d3-71ec622126c2", "f10bc353-01ab-4db1-af9f-d9305ea9a532"}
	all, err := selectActivityStartGPSUsers(allowed, nil)
	if err != nil || !reflect.DeepEqual(all, allowed) {
		t.Fatalf("all users = (%v, %v)", all, err)
	}

	want := allowed[0]
	selected, err := selectActivityStartGPSUsers(allowed, []string{want, want})
	if err != nil || !reflect.DeepEqual(selected, []string{want}) {
		t.Fatalf("selected = (%v, %v)", selected, err)
	}
	if _, err := selectActivityStartGPSUsers(allowed, []string{"11c2e582-5a85-4633-81d2-df7e37ad7b48"}); err == nil {
		t.Fatal("test user was accepted")
	}
	if _, err := selectActivityStartGPSUsers(nil, nil); err == nil {
		t.Fatal("empty allowlist was accepted")
	}
}
