package main

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/factorybridge/iotconnector/gateway-go/internal/db"
)

// chdirTemp 切到一个模拟仓库根的临时目录（含 apps/gateway-go）。
func chdirTemp(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "apps", "gateway-go"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Chdir(root)
	return root
}

func TestDefaultDataDirIsSeparateFromNode(t *testing.T) {
	chdirTemp(t)
	if got, want := defaultDataDir(), filepath.Join("apps", "gateway-go", "data"); got != want {
		t.Fatalf("defaultDataDir = %q, want %q", got, want)
	}
}

func TestImportLegacyDataDirCopiesStateOnce(t *testing.T) {
	root := chdirTemp(t)
	legacy := filepath.Join(root, "apps", "gateway", "data")
	if err := os.MkdirAll(legacy, 0o755); err != nil {
		t.Fatal(err)
	}
	mustWrite(t, filepath.Join(legacy, "config.json"), `{"channels":[]}`)
	mustWrite(t, filepath.Join(legacy, "shadow.json"), `{}`)
	mustWrite(t, filepath.Join(legacy, "history.jsonl.migrated"), "old")
	database, err := db.Open(context.Background(), legacy)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := database.Exec(`INSERT INTO users (id, username, password_hash, role, created_at, updated_at) VALUES ('u1','alice','x','admin',0,0)`); err != nil {
		t.Fatal(err)
	}
	// 旧库保持打开，模拟旧网关仍在运行；t.Cleanup 先于 TempDir 删除执行。
	t.Cleanup(func() { database.Close() })

	var log bytes.Buffer
	dir, err := resolveDataDir(defaultDataDir(), false, &log)
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"config.json", "shadow.json", db.FileName} {
		if !isFile(filepath.Join(dir, name)) {
			t.Fatalf("%s not copied; log: %s", name, log.String())
		}
	}
	if isFile(filepath.Join(dir, "history.jsonl.migrated")) {
		t.Fatal("*.migrated files must not be copied")
	}
	copied, err := db.Open(context.Background(), dir)
	if err != nil {
		t.Fatal(err)
	}
	var count int
	if err := copied.QueryRow(`SELECT COUNT(*) FROM users`).Scan(&count); err != nil || count != 1 {
		t.Fatalf("users in copied db = %d, %v", count, err)
	}
	copied.Close()
	if !isFile(filepath.Join(legacy, "config.json")) || !isFile(filepath.Join(legacy, "shadow.json")) {
		t.Fatal("legacy directory was modified")
	}

	// 第二次启动：新目录已有状态，不再覆盖。
	mustWrite(t, filepath.Join(dir, "config.json"), `{"edited":true}`)
	log.Reset()
	if _, err := resolveDataDir(defaultDataDir(), false, &log); err != nil {
		t.Fatal(err)
	}
	if data, _ := os.ReadFile(filepath.Join(dir, "config.json")); !strings.Contains(string(data), "edited") {
		t.Fatal("second start overwrote config.json")
	}
	if log.Len() != 0 {
		t.Fatalf("unexpected import on second start: %s", log.String())
	}
}

func TestExplicitDataDirSkipsImport(t *testing.T) {
	root := chdirTemp(t)
	legacy := filepath.Join(root, "apps", "gateway", "data")
	if err := os.MkdirAll(legacy, 0o755); err != nil {
		t.Fatal(err)
	}
	mustWrite(t, filepath.Join(legacy, "config.json"), `{}`)
	var log bytes.Buffer
	dir, err := resolveDataDir(defaultDataDir(), true, &log)
	if err != nil {
		t.Fatal(err)
	}
	if isFile(filepath.Join(dir, "config.json")) || log.Len() != 0 {
		t.Fatal("explicit data dir must not import")
	}
}

func mustWrite(t *testing.T, path, content string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}
