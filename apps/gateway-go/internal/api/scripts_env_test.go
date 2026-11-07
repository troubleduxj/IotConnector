package api

import (
	"os"
	"strings"
	"testing"
)

func TestScriptWorkerEnvDropsSecrets(t *testing.T) {
	t.Setenv("TDENGINE_PASSWORD", "s3cret")
	t.Setenv("GATEWAY_GO_ADMIN_TOKEN", "tok")
	env := scriptWorkerEnv()

	for _, kv := range env {
		if strings.Contains(kv, "s3cret") {
			t.Fatalf("secret leaked into worker env: %q", kv)
		}
		key, _, _ := strings.Cut(kv, "=")
		if strings.HasPrefix(strings.ToUpper(key), "TDENGINE_") || strings.HasPrefix(strings.ToUpper(key), "GATEWAY_GO_ADMIN") {
			t.Fatalf("non-allowlisted key leaked into worker env: %q", kv)
		}
	}
	if !containsEnv(env, "GATEWAY_GO_SCRIPT_WORKER=1") {
		t.Fatal("worker env missing GATEWAY_GO_SCRIPT_WORKER=1")
	}
}

func TestScriptWorkerEnvKeepsPath(t *testing.T) {
	path, ok := os.LookupEnv("PATH")
	if !ok {
		t.Skip("PATH not set")
	}
	env := scriptWorkerEnv()
	for _, kv := range env {
		key, value, _ := strings.Cut(kv, "=")
		if strings.ToUpper(key) == "PATH" {
			if value != path {
				t.Fatalf("PATH value changed: got %q want %q", value, path)
			}
			return
		}
	}
	t.Fatal("PATH missing from worker env")
}

func containsEnv(env []string, want string) bool {
	for _, kv := range env {
		if kv == want {
			return true
		}
	}
	return false
}
