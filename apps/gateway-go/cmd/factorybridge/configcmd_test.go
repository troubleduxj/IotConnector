package main

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestConfigListAndExport(t *testing.T) {
	resetSettings(t)
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "config.json"), []byte(`{"schemaVersion":2,"channels":[{"id":"c1","name":"PLC","protocol":"Modbus TCP","host":"h","port":502}],"tags":[]}`), 0o640); err != nil {
		t.Fatal(err)
	}
	var stdout, stderr bytes.Buffer
	if code := dispatch([]string{"config", "list", "--data-dir", dir}, &stdout, &stderr); code != exitOK {
		t.Fatalf("list exit=%d stderr=%s", code, stderr.String())
	}
	if !strings.Contains(stdout.String(), "import:config.json") {
		t.Fatalf("list output: %s", stdout.String())
	}
	out := filepath.Join(dir, "exported.json")
	stdout.Reset()
	if code := dispatch([]string{"config", "export", "--data-dir", dir, "--out", out}, &stdout, &stderr); code != exitOK {
		t.Fatalf("export exit=%d stderr=%s", code, stderr.String())
	}
	data, err := os.ReadFile(out)
	if err != nil || !strings.Contains(string(data), `"name": "PLC"`) {
		t.Fatalf("exported: %v %s", err, data)
	}
	if code := dispatch([]string{"config", "export", "--data-dir", dir, "--version", "99"}, &stdout, &stderr); code != exitUsage {
		t.Fatalf("missing version exit=%d", code)
	}
	if code := dispatch([]string{"config", "bogus", "--data-dir", dir}, &stdout, &stderr); code != exitUsage {
		t.Fatalf("unknown subcommand exit=%d", code)
	}
}
