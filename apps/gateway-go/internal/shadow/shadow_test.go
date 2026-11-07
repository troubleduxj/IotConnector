package shadow

import (
	"context"
	"os"
	"testing"

	"github.com/factorybridge/iotconnector/gateway-go/internal/db"
)

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

func TestDBStorePersistsRowsAndImportsLegacy(t *testing.T) {
	dir := t.TempDir()
	legacy := dir + "/shadow.json"
	file := New(legacy, nil)
	file.SetDesired("tag-1", 7.0, "op")
	file.SetReported("tag-2", true, "Good", 5)

	database, err := db.Open(context.Background(), dir)
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	batch := db.NewBatch(database)
	store := NewDB(database, batch, legacy, nil)
	if len(store.Snapshot()) != 2 {
		t.Fatalf("import got %d entries", len(store.Snapshot()))
	}
	if _, err := os.Stat(legacy + ".migrated"); err != nil {
		t.Fatalf("legacy shadow not renamed: %v", err)
	}
	store.SetReported("tag-1", 7.0, "Good", 9)
	if err := batch.Flush(context.Background()); err != nil {
		t.Fatal(err)
	}
	reloaded := NewDB(database, batch, legacy, nil)
	if got := reloaded.PendingCount(); got != 0 {
		t.Fatalf("pending after reload = %d", got)
	}
	var rows int
	_ = database.QueryRow(`SELECT COUNT(*) FROM shadow_entries`).Scan(&rows)
	if rows != 2 {
		t.Fatalf("rows=%d want 2 (one per tag)", rows)
	}
}

func TestUnchangedReportIsNotWritten(t *testing.T) {
	database, err := db.Open(context.Background(), t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	batch := db.NewBatch(database)
	store := NewDB(database, batch, "", nil)
	store.SetReported("tag-1", 1.0, "Good", 1)
	_ = batch.Flush(context.Background())
	store.SetReported("tag-1", 1.0, "Good", 1)
	if pending, _, _ := batch.Stats(); pending != 0 {
		t.Fatalf("identical report queued %d writes", pending)
	}
}
