package auth

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestSessionLifecycleAndExpiry(t *testing.T) {
	manager := NewManager(20 * time.Millisecond)
	token, session, err := manager.Create("operator", RoleOperator)
	if err != nil || token == "" || session.Role != RoleOperator {
		t.Fatalf("create session: token=%q session=%#v err=%v", token, session, err)
	}
	if got, ok := manager.Authenticate(token); !ok || got.Username != "operator" {
		t.Fatalf("authenticate failed: %#v %v", got, ok)
	}
	time.Sleep(30 * time.Millisecond)
	if _, ok := manager.Authenticate(token); ok {
		t.Fatal("expired session was accepted")
	}
}

func TestSessionPersistenceStoresOnlyTokenHash(t *testing.T) {
	path := filepath.Join(t.TempDir(), "sessions.json")
	first := NewManager(time.Hour, path)
	token, _, err := first.Create("admin", RoleAdmin)
	if err != nil {
		t.Fatal(err)
	}
	contents, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(contents), token) {
		t.Fatal("raw session token was persisted")
	}
	second := NewManager(time.Hour, path)
	if session, ok := second.Authenticate(token); !ok || session.Username != "admin" {
		t.Fatalf("persisted session was not restored: %#v %v", session, ok)
	}
}
