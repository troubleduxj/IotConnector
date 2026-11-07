package db

import (
	"context"
	"errors"
	"path/filepath"
	"testing"
	"time"
)

func openTemp(t *testing.T) *DB {
	t.Helper()
	database, err := OpenPath(context.Background(), filepath.Join(t.TempDir(), "x.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { database.Close() })
	return database
}

func count(t *testing.T, database *DB, table string) int {
	t.Helper()
	var n int
	if err := database.QueryRow("SELECT COUNT(*) FROM " + table).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func TestBatchCommitsInOneTransaction(t *testing.T) {
	database := openTemp(t)
	batch := NewBatch(database)
	for i := 0; i < 1000; i++ {
		batch.Exec(`INSERT INTO history_points(tag_id, ts, value) VALUES (?, ?, ?)`, "t1", i, float64(i))
	}
	if n := count(t, database, "history_points"); n != 0 {
		t.Fatalf("writes visible before flush: %d", n)
	}
	if err := batch.Flush(context.Background()); err != nil {
		t.Fatal(err)
	}
	if n := count(t, database, "history_points"); n != 1000 {
		t.Fatalf("after flush: %d", n)
	}
	if pending, _, _ := batch.Stats(); pending != 0 {
		t.Fatalf("pending=%d", pending)
	}
}

func TestBatchRequeuesOnFailure(t *testing.T) {
	database := openTemp(t)
	batch := NewBatch(database)
	batch.Exec(`INSERT INTO history_points(tag_id, ts, value) VALUES (?, ?, ?)`, "t1", 1, 1.0)
	batch.Exec(`INSERT INTO no_such_table VALUES (1)`)
	if err := batch.Flush(context.Background()); err == nil {
		t.Fatal("expected failure")
	}
	if n := count(t, database, "history_points"); n != 0 {
		t.Fatal("partial batch committed; transaction not atomic")
	}
	if pending, _, failures := batch.Stats(); pending != 2 || failures != 1 {
		t.Fatalf("pending=%d failures=%d", pending, failures)
	}
}

func TestBatchCapsPendingQueue(t *testing.T) {
	batch := NewBatch(openTemp(t))
	batch.maxQueue = 10
	for i := 0; i < 15; i++ {
		batch.Exec(`INSERT INTO history_points(tag_id, ts, value) VALUES ('t', ?, 0)`, i)
	}
	if pending, dropped, _ := batch.Stats(); pending != 10 || dropped != 5 {
		t.Fatalf("pending=%d dropped=%d", pending, dropped)
	}
}

func TestBatchRunFlushesOnShutdown(t *testing.T) {
	database := openTemp(t)
	batch := NewBatch(database)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { batch.Run(ctx, time.Hour); close(done) }()
	batch.Exec(`INSERT INTO history_points(tag_id, ts, value) VALUES ('t', 1, 0)`)
	cancel()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("Run did not return")
	}
	if n := count(t, database, "history_points"); n != 1 {
		t.Fatalf("final flush missing: %d", n)
	}
}

func TestBatchRunKicksWhenFull(t *testing.T) {
	database := openTemp(t)
	batch := NewBatch(database)
	batch.maxOps = 5
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go batch.Run(ctx, time.Hour)
	for i := 0; i < 5; i++ {
		batch.Exec(`INSERT INTO history_points(tag_id, ts, value) VALUES ('t', ?, 0)`, i)
	}
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if count(t, database, "history_points") == 5 {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("full batch was not flushed early")
}

func TestNilBatchIsNoop(t *testing.T) {
	var batch *Batch
	batch.Exec("ignored")
	if err := batch.Flush(context.Background()); err != nil && !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
}
