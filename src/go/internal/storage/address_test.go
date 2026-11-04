package storage

import (
	"context"
	"testing"
)

// ─────────────────────────────────────────────────────────────────────────────
// Address book: ≤10 cap, single-default invariant, hard delete
// ─────────────────────────────────────────────────────────────────────────────

func addrInput(name string, isDefault bool) AddressInput {
	return AddressInput{
		ReceiverName: name, ReceiverPhone: "13900139000",
		Province: "北京市", City: "北京市", District: "海淀区",
		AddressDetail: "知春路 " + name, IsDefault: isDefault,
	}
}

func TestUserAddress_CapDefaultUniqueness(t *testing.T) {
	st := openTestStore(t)
	ctx := context.Background()
	migrateRedemptionTables(t, st)
	uid := redemptionUser(t)

	// First entry becomes the default automatically.
	first, err := st.CreateAddress(ctx, uid, addrInput("a1", false))
	if err != nil {
		t.Fatalf("create 1: %v", err)
	}
	if !first.IsDefault {
		t.Fatal("first entry must auto-default")
	}
	// A non-default second entry leaves the default alone.
	second, err := st.CreateAddress(ctx, uid, addrInput("a2", false))
	if err != nil {
		t.Fatalf("create 2: %v", err)
	}
	if second.IsDefault {
		t.Fatal("second entry must not steal the default")
	}
	// An explicit is_default flips it and clears the old one in the same tx.
	third, err := st.CreateAddress(ctx, uid, addrInput("a3", true))
	if err != nil {
		t.Fatalf("create 3: %v", err)
	}
	if !third.IsDefault {
		t.Fatal("explicit default not honored")
	}
	rows, err := st.ListAddresses(ctx, uid)
	if err != nil {
		t.Fatal(err)
	}
	defaults := 0
	for _, r := range rows {
		if r.IsDefault {
			defaults++
		}
	}
	if defaults != 1 {
		t.Fatalf("defaults = %d, want exactly 1", defaults)
	}
	if rows[0].ID != third.ID {
		t.Fatalf("default not listed first: rows[0] = %d", rows[0].ID)
	}

	// The 11th entry is rejected (#850 resolution: 每用户 ≤10 条).
	for i := len(rows); i < MaxAddressesPerUser; i++ {
		if _, err := st.CreateAddress(ctx, uid, addrInput("fill", false)); err != nil {
			t.Fatalf("fill %d: %v", i+1, err)
		}
	}
	if _, err := st.CreateAddress(ctx, uid, addrInput("a11", false)); err != ErrAddressLimitReached {
		t.Fatalf("11th entry err = %v, want ErrAddressLimitReached", err)
	}
	// Another user's cap is independent.
	if _, err := st.CreateAddress(ctx, redemptionUser(t), addrInput("other", false)); err != nil {
		t.Fatalf("other user create: %v", err)
	}
}

func TestUserAddress_UpdateSetDefaultDelete(t *testing.T) {
	st := openTestStore(t)
	ctx := context.Background()
	migrateRedemptionTables(t, st)
	uid := redemptionUser(t)
	a, err := st.CreateAddress(ctx, uid, addrInput("u1", false))
	if err != nil {
		t.Fatal(err)
	}
	b, err := st.CreateAddress(ctx, uid, addrInput("u2", false))
	if err := err; err != nil {
		t.Fatal(err)
	}

	// Partial update keeps absent fields.
	newName := "李四"
	patched, err := st.UpdateAddress(ctx, uid, a.ID, AddressPatch{ReceiverName: &newName})
	if err != nil {
		t.Fatalf("update: %v", err)
	}
	if patched.ReceiverName != newName || patched.AddressDetail != a.AddressDetail {
		t.Fatalf("patched = %+v", patched)
	}

	// SetDefault moves the single flag.
	if _, err := st.SetDefaultAddress(ctx, uid, b.ID); err != nil {
		t.Fatalf("set default: %v", err)
	}
	rows, err := st.ListAddresses(ctx, uid)
	if err != nil {
		t.Fatal(err)
	}
	for _, r := range rows {
		want := r.ID == b.ID
		if r.IsDefault != want {
			t.Fatalf("row %d is_default = %v, want %v", r.ID, r.IsDefault, want)
		}
	}

	// Hard delete; history is snapshot-backed so this is safe by design.
	if err := st.DeleteAddress(ctx, uid, a.ID); err != nil {
		t.Fatalf("delete: %v", err)
	}
	if err := st.DeleteAddress(ctx, uid, a.ID); err != ErrAddressNotFound {
		t.Fatalf("re-delete err = %v, want ErrAddressNotFound", err)
	}
	// Ownership is part of the key: a foreign id answers not-found, never leaks.
	if _, err := st.UpdateAddress(ctx, redemptionUser(t), b.ID, AddressPatch{}); err != ErrAddressNotFound {
		t.Fatalf("foreign update err = %v, want ErrAddressNotFound", err)
	}
	if _, err := st.SetDefaultAddress(ctx, redemptionUser(t), b.ID); err != ErrAddressNotFound {
		t.Fatalf("foreign set-default err = %v, want ErrAddressNotFound", err)
	}
}

func TestUserAddress_Validation(t *testing.T) {
	st := openTestStore(t)
	ctx := context.Background()
	migrateRedemptionTables(t, st)
	uid := redemptionUser(t)
	bad := addrInput("ok", false)
	bad.City = ""
	if _, err := st.CreateAddress(ctx, uid, bad); err == nil {
		t.Fatal("empty city accepted")
	}
}
