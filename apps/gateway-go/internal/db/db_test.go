package db

import (
	"context"
	"path/filepath"
	"sync"
	"testing"
)

func TestOpenAppliesMigrationsIdempotently(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	first, err := Open(ctx, dir)
	if err != nil {
		t.Fatal(err)
	}
	version, err := first.SchemaVersion(ctx)
	if err != nil || version != migrations[len(migrations)-1].version {
		t.Fatalf("version=%d err=%v", version, err)
	}
	var mode string
	if err := first.QueryRowContext(ctx, "PRAGMA journal_mode").Scan(&mode); err != nil || mode != "wal" {
		t.Fatalf("journal_mode=%q err=%v", mode, err)
	}
	if _, err := first.ExecContext(ctx, `INSERT INTO users(id, username, password_hash, role, created_at, updated_at) VALUES ('u1','Admin','h','admin',0,0)`); err != nil {
		t.Fatal(err)
	}
	first.Close()

	second, err := Open(ctx, dir)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	defer second.Close()
	var count int
	if err := second.QueryRowContext(ctx, `SELECT COUNT(*) FROM schema_migrations`).Scan(&count); err != nil || count != len(migrations) {
		t.Fatalf("migrations applied %d times, err=%v", count, err)
	}
	// 用户名不区分大小写唯一
	if _, err := second.ExecContext(ctx, `INSERT INTO users(id, username, password_hash, role, created_at, updated_at) VALUES ('u2','admin','h','admin',0,0)`); err == nil {
		t.Fatal("duplicate username with different case was accepted")
	}
	if _, err := second.ExecContext(ctx, `INSERT INTO users(id, username, password_hash, role, created_at, updated_at) VALUES ('u3','x','h','root',0,0)`); err == nil {
		t.Fatal("invalid role was accepted")
	}
}

func TestOpenRefusesNewerSchema(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	db, err := Open(ctx, dir)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO schema_migrations(version, name, applied_at) VALUES (999, 'future', 0)`); err != nil {
		t.Fatal(err)
	}
	db.Close()
	if _, err := Open(ctx, dir); err == nil {
		t.Fatal("opened a database with a newer schema")
	}
}

func TestSessionsCascadeOnUserDelete(t *testing.T) {
	ctx := context.Background()
	db, err := OpenPath(ctx, filepath.Join(t.TempDir(), "x.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	mustExec(t, db, `INSERT INTO users(id, username, password_hash, role, created_at, updated_at) VALUES ('u1','a','h','admin',0,0)`)
	mustExec(t, db, `INSERT INTO sessions(token_hash, user_id, token_version, created_at, expires_at, last_seen_at) VALUES ('t1','u1',1,0,0,0)`)
	mustExec(t, db, `DELETE FROM users WHERE id='u1'`)
	var count int
	_ = db.QueryRowContext(ctx, `SELECT COUNT(*) FROM sessions`).Scan(&count)
	if count != 0 {
		t.Fatal("foreign_keys pragma not applied: session survived user delete")
	}
}

func TestConcurrentWritesDoNotReturnBusy(t *testing.T) {
	ctx := context.Background()
	db, err := OpenPath(ctx, filepath.Join(t.TempDir(), "x.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	mustExec(t, db, `INSERT INTO users(id, username, password_hash, role, created_at, updated_at) VALUES ('u1','a','h','admin',0,0)`)
	var wg sync.WaitGroup
	errs := make(chan error, 200)
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func(n int) {
			defer wg.Done()
			for j := 0; j < 25; j++ {
				_, err := db.ExecContext(ctx, `INSERT INTO sessions(token_hash, user_id, token_version, created_at, expires_at, last_seen_at) VALUES (?, 'u1', 1, 0, 0, 0)`,
					string(rune('a'+n))+string(rune('a'+j)))
				if err != nil {
					errs <- err
				}
			}
		}(i)
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Fatalf("concurrent insert: %v", err)
	}
}

func mustExec(t *testing.T, db *DB, query string) {
	t.Helper()
	if _, err := db.Exec(query); err != nil {
		t.Fatalf("%s: %v", query, err)
	}
}
