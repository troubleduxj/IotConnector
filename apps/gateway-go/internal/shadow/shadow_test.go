package shadow

import "testing"

func TestStoreConvergesAndPersists(t *testing.T) {
	path := t.TempDir() + "/shadow.json"
	store := New(path, nil)
	store.SetDesired("tag-1", 42.0, "operator")
	store.SetReported("tag-1", 41.0, "Good", 100)
	if got := store.PendingCount(); got != 1 {
		t.Fatalf("pending before convergence = %d, want 1", got)
	}
	store.SetReported("tag-1", 42.0, "Good", 200)
	if got := store.PendingCount(); got != 0 {
		t.Fatalf("pending after convergence = %d, want 0", got)
	}
	reloaded := New(path, nil)
	entries := reloaded.Snapshot()
	if len(entries) != 1 || entries[0].Desired == nil || entries[0].Reported == nil {
		t.Fatalf("reloaded entries = %#v", entries)
	}
	if entries[0].Desired.Value != 42.0 || entries[0].Reported.Value != 42.0 {
		t.Fatalf("reloaded values = desired=%#v reported=%#v", entries[0].Desired.Value, entries[0].Reported.Value)
	}
}

func TestStoreChangeCallbackOnlyOnReportedChange(t *testing.T) {
	changes := 0
	store := New("", func() { changes++ })
	store.SetReported("tag-1", true, "Good", 1)
	store.SetReported("tag-1", true, "Good", 1)
	store.SetDesired("tag-1", true, "operator")
	if changes != 2 {
		t.Fatalf("change callbacks = %d, want 2", changes)
	}
}
