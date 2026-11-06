package auth

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"unicode"

	"golang.org/x/crypto/bcrypt"
)

type PasswordRecord struct {
	Username   string `json:"username"`
	Hash       string `json:"hash"`
	MustChange bool   `json:"mustChangePassword"`
}

type PasswordStore struct {
	mu     sync.RWMutex
	path   string
	record PasswordRecord
}

func OpenPasswordStore(path, username, password, passwordHash string, mustChange bool) (*PasswordStore, error) {
	store := &PasswordStore{path: path}
	if path != "" {
		if data, err := os.ReadFile(path); err == nil {
			if err := json.Unmarshal(data, &store.record); err != nil {
				return nil, fmt.Errorf("parse password store: %w", err)
			}
			return store, nil
		} else if !os.IsNotExist(err) {
			return nil, fmt.Errorf("read password store: %w", err)
		}
	}
	if username == "" || (password == "" && passwordHash == "") {
		return store, nil
	}
	if passwordHash == "" {
		hash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
		if err != nil {
			return nil, fmt.Errorf("hash initial password: %w", err)
		}
		passwordHash = string(hash)
	}
	store.record = PasswordRecord{Username: username, Hash: passwordHash, MustChange: mustChange}
	if err := store.persist(); err != nil {
		return nil, err
	}
	return store, nil
}

func (s *PasswordStore) Enabled() bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.record.Username != "" && s.record.Hash != ""
}

func (s *PasswordStore) Verify(username, password string) bool {
	s.mu.RLock()
	record := s.record
	s.mu.RUnlock()
	return username == record.Username && bcrypt.CompareHashAndPassword([]byte(record.Hash), []byte(password)) == nil
}

func (s *PasswordStore) Record() PasswordRecord {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.record
}

func (s *PasswordStore) ChangePassword(current, next string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if bcrypt.CompareHashAndPassword([]byte(s.record.Hash), []byte(current)) != nil {
		return fmt.Errorf("current password is incorrect")
	}
	if err := ValidatePassword(next); err != nil {
		return err
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(next), bcrypt.DefaultCost)
	if err != nil {
		return fmt.Errorf("hash password: %w", err)
	}
	s.record.Hash = string(hash)
	s.record.MustChange = false
	return s.persistLocked()
}

func ValidatePassword(password string) error {
	if len([]rune(password)) < 12 {
		return fmt.Errorf("password must be at least 12 characters")
	}
	var upper, lower, digit, special bool
	for _, r := range password {
		switch {
		case unicode.IsUpper(r):
			upper = true
		case unicode.IsLower(r):
			lower = true
		case unicode.IsDigit(r):
			digit = true
		default:
			special = true
		}
	}
	if !upper || !lower || !digit || !special {
		return fmt.Errorf("password must include upper, lower, digit, and special characters")
	}
	return nil
}

func (s *PasswordStore) persist() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.persistLocked()
}

func (s *PasswordStore) persistLocked() error {
	if s.path == "" {
		return nil
	}
	b, err := json.MarshalIndent(s.record, "", "  ")
	if err != nil {
		return fmt.Errorf("encode password store: %w", err)
	}
	if err := os.MkdirAll(filepath.Dir(s.path), 0o750); err != nil {
		return fmt.Errorf("create password store directory: %w", err)
	}
	suffix := make([]byte, 8)
	if _, err := rand.Read(suffix); err != nil {
		return fmt.Errorf("create password temp name: %w", err)
	}
	tmp := filepath.Join(filepath.Dir(s.path), ".auth-"+hex.EncodeToString(suffix)+".json")
	if err := os.WriteFile(tmp, append(b, '\n'), 0o640); err != nil {
		return fmt.Errorf("write password store: %w", err)
	}
	if err := os.Rename(tmp, s.path); err != nil {
		_ = os.Remove(tmp)
		return fmt.Errorf("replace password store: %w", err)
	}
	return nil
}

func IsBlank(value string) bool { return strings.TrimSpace(value) == "" }
