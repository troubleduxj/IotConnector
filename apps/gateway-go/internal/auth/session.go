package auth

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"
)

type Role string

const (
	RoleViewer   Role = "viewer"
	RoleOperator Role = "operator"
	RoleAdmin    Role = "admin"
)

type Session struct {
	Username           string
	Role               Role
	Expires            time.Time
	MustChangePassword bool
}

type Manager struct {
	mu       sync.Mutex
	sessions map[string]Session
	ttl      time.Duration
	path     string
}

func NewManager(ttl time.Duration, persistencePath ...string) *Manager {
	if ttl <= 0 {
		ttl = 8 * time.Hour
	}
	path := ""
	if len(persistencePath) > 0 {
		path = persistencePath[0]
	}
	manager := &Manager{sessions: make(map[string]Session), ttl: ttl, path: path}
	manager.load()
	return manager
}

func (m *Manager) Create(username string, role Role) (string, Session, error) {
	return m.CreateWithState(username, role, false)
}

func (m *Manager) CreateWithState(username string, role Role, mustChangePassword bool) (string, Session, error) {
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return "", Session{}, err
	}
	token := base64.RawURLEncoding.EncodeToString(buf)
	session := Session{Username: username, Role: role, Expires: time.Now().Add(m.ttl), MustChangePassword: mustChangePassword}
	m.mu.Lock()
	m.sessions[tokenHash(token)] = session
	_ = m.persistLocked()
	m.mu.Unlock()
	return token, session, nil
}

func (m *Manager) MarkPasswordChanged(token string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	key := tokenHash(token)
	if session, ok := m.sessions[key]; ok {
		session.MustChangePassword = false
		m.sessions[key] = session
		_ = m.persistLocked()
	}
}

func (m *Manager) Authenticate(token string) (Session, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	key := tokenHash(token)
	session, ok := m.sessions[key]
	if !ok {
		return Session{}, false
	}
	if time.Now().After(session.Expires) {
		delete(m.sessions, key)
		_ = m.persistLocked()
		return Session{}, false
	}
	return session, true
}

func (m *Manager) Revoke(token string) {
	m.mu.Lock()
	delete(m.sessions, tokenHash(token))
	_ = m.persistLocked()
	m.mu.Unlock()
}

func tokenHash(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

func (m *Manager) load() {
	if m.path == "" {
		return
	}
	b, err := os.ReadFile(m.path)
	if err != nil {
		return
	}
	var sessions map[string]Session
	if json.Unmarshal(b, &sessions) == nil {
		for key, session := range sessions {
			if time.Now().Before(session.Expires) && len(key) == sha256.Size*2 {
				m.sessions[key] = session
			}
		}
	}
}

func (m *Manager) persistLocked() error {
	if m.path == "" {
		return nil
	}
	b, err := json.MarshalIndent(m.sessions, "", "  ")
	if err != nil {
		return fmt.Errorf("encode sessions: %w", err)
	}
	if err := os.MkdirAll(filepath.Dir(m.path), 0o750); err != nil {
		return fmt.Errorf("create session directory: %w", err)
	}
	tmp, err := os.CreateTemp(filepath.Dir(m.path), ".sessions-*.json")
	if err != nil {
		return fmt.Errorf("create session temp file: %w", err)
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)
	if err := tmp.Chmod(0o640); err != nil {
		_ = tmp.Close()
		return err
	}
	if _, err := tmp.Write(append(b, '\n')); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Rename(tmpName, m.path); err != nil {
		return fmt.Errorf("replace sessions: %w", err)
	}
	return nil
}
