package main

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"golang.org/x/crypto/bcrypt"
)

func TestMigrateNothingToImport(t *testing.T) {
	dir := t.TempDir()
	var stdout, stderr bytes.Buffer
	if code := dispatch([]string{"migrate", "--data-dir", dir}, &stdout, &stderr); code != exitOK {
		t.Fatalf("exit=%d stderr=%q", code, stderr.String())
	}
	if !strings.Contains(stdout.String(), "没有待导入的旧状态文件") {
		t.Errorf("stdout = %q", stdout.String())
	}
	if _, err := os.Stat(filepath.Join(dir, "gateway.db")); !os.IsNotExist(err) {
		t.Errorf("migrate with nothing to import should not create gateway.db, stat err=%v", err)
	}
}

func TestMigrateDryRunListsWithoutChanges(t *testing.T) {
	dir := t.TempDir()
	legacy := []byte(`{"username":"x","hash":"y"}`)
	authPath := filepath.Join(dir, "auth.json")
	if err := os.WriteFile(authPath, legacy, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "shadow.json"), []byte(`{}`), 0o600); err != nil {
		t.Fatal(err)
	}

	var stdout, stderr bytes.Buffer
	if code := dispatch([]string{"migrate", "--dry-run", "--data-dir", dir}, &stdout, &stderr); code != exitOK {
		t.Fatalf("exit=%d stderr=%q", code, stderr.String())
	}
	out := stdout.String()
	if !strings.Contains(out, "待导入") || !strings.Contains(out, "auth.json") || !strings.Contains(out, "shadow.json") {
		t.Errorf("dry-run listing = %q", out)
	}
	if !strings.Contains(out, "   ") || !strings.Contains(out, "字节") {
		t.Errorf("dry-run should show sizes: %q", out)
	}
	if _, err := os.Stat(authPath); err != nil {
		t.Errorf("dry-run must not touch auth.json: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, "gateway.db")); !os.IsNotExist(err) {
		t.Errorf("dry-run must not create gateway.db, stat err=%v", err)
	}
}

func TestMigrateImportsLegacyAuth(t *testing.T) {
	dir := t.TempDir()
	hash, err := bcrypt.GenerateFromPassword([]byte(covGoodPassword), bcrypt.MinCost)
	if err != nil {
		t.Fatal(err)
	}
	legacy, _ := json.Marshal(map[string]any{"username": "migr-admin", "hash": string(hash)})
	authPath := filepath.Join(dir, "auth.json")
	if err := os.WriteFile(authPath, legacy, 0o600); err != nil {
		t.Fatal(err)
	}

	var stdout, stderr bytes.Buffer
	code := dispatch([]string{"migrate", "--data-dir", dir}, &stdout, &stderr)
	if code != exitOK {
		t.Fatalf("exit=%d stdout=%q stderr=%q", code, stdout.String(), stderr.String())
	}
	out := stdout.String()
	if !strings.Contains(out, `imported legacy admin "migr-admin"`) {
		t.Errorf("missing import line: %q", out)
	}
	if !strings.Contains(out, "users") || !strings.Contains(out, "原文件已改名为 *.migrated") {
		t.Errorf("missing report: %q", out)
	}
	if _, err := os.Stat(authPath + ".migrated"); err != nil {
		t.Errorf("auth.json.migrated missing: %v", err)
	}

	// 第二次执行没有待导入文件，应当直接结束。
	stdout.Reset()
	if code := dispatch([]string{"migrate", "--data-dir", dir}, &stdout, &stderr); code != exitOK || !strings.Contains(stdout.String(), "没有待导入") {
		t.Errorf("second run: exit=%d out=%q", code, stdout.String())
	}
}
