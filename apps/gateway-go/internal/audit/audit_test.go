package audit

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/factorybridge/iotconnector/gateway-go/internal/db"
)

func TestLoggerAppendsJSONLines(t *testing.T) {
	path := filepath.Join(t.TempDir(), "nested", "audit.jsonl")
	logger := New(path)
	if err := logger.Record(Event{Actor: "tester", Action: "tag.write", Target: "tag-1"}); err != nil {
		t.Fatal(err)
	}
	if err := logger.Record(Event{Actor: "tester", Action: "tag.write", Target: "tag-2"}); err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(strings.TrimSpace(string(b)), "\n")
	if len(lines) != 2 {
		t.Fatalf("audit lines=%d content=%s", len(lines), b)
	}
}

func TestDBLoggerImportsLegacyAndQueries(t *testing.T) {
	dir := t.TempDir()
	legacy := filepath.Join(dir, "audit.jsonl")
	_ = os.WriteFile(legacy, []byte(`{"at":"2026-09-01T00:00:00Z","actor":"old","action":"tag.write","target":"t1"}
not-json
{"at":"2026-09-02T00:00:00Z","actor":"old","action":"auth.login","target":""}
`), 0o600)
	database, err := db.Open(context.Background(), dir)
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	logger := NewDB(database, legacy)
	if _, err := os.Stat(legacy + ".migrated"); err != nil {
		t.Fatalf("legacy not renamed: %v", err)
	}
	if err := logger.Record(Event{Actor: "admin", Action: "user.create", Target: "u1", Detail: map[string]any{"role": "viewer"}}); err != nil {
		t.Fatal(err)
	}
	events, err := logger.Recent(10)
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 3 || events[0].Action != "user.create" || events[0].Detail["role"] != "viewer" || events[2].Action != "tag.write" {
		t.Fatalf("events=%+v", events)
	}
	// 再次打开不得重复导入
	NewDB(database, legacy)
	if again, _ := logger.Recent(10); len(again) != 3 {
		t.Fatalf("imported twice: %d", len(again))
	}
	if err := logger.Prune(context.Background()); err != nil {
		t.Fatal(err)
	}
	if after, _ := logger.Recent(10); len(after) != 3 {
		t.Fatalf("prune removed events inside retention: left %d", len(after))
	}
	if _, err := database.Exec(`INSERT INTO audit_events(at, actor, action, target, detail) VALUES (?, 'x', 'expired', '', 'null')`,
		time.Now().Add(-Retention-time.Hour).UnixMilli()); err != nil {
		t.Fatal(err)
	}
	if err := logger.Prune(context.Background()); err != nil {
		t.Fatal(err)
	}
	if after, _ := logger.Recent(10); len(after) != 3 {
		t.Fatalf("prune kept an expired event: %d", len(after))
	}
}
