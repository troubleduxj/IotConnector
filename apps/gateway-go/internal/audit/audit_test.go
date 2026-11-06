package audit

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
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
