package config

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"github.com/factorybridge/iotconnector/gateway-go/internal/domain"
)

const CurrentSchemaVersion = 2

// Config intentionally keeps unknown fields. This allows the Go migration
// process to read and rewrite Node-owned configuration without silently
// dropping recipes, scripts, notification settings, or future fields.
type Config struct {
	SchemaVersion int              `json:"schemaVersion"`
	Channels      []domain.Channel `json:"channels"`
	Tags          []domain.Tag     `json:"tags"`
	Raw           map[string]any   `json:"-"`
}

type Store struct {
	Dir  string
	Path string
}

func NewStore(dir string) Store {
	return Store{Dir: dir, Path: filepath.Join(dir, "config.json")}
}

func (s Store) Load() (Config, error) {
	b, err := os.ReadFile(s.Path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return Config{SchemaVersion: CurrentSchemaVersion, Raw: map[string]any{}}, nil
		}
		return Config{}, fmt.Errorf("read config: %w", err)
	}

	var raw map[string]any
	if err := json.Unmarshal(b, &raw); err != nil {
		return Config{}, fmt.Errorf("parse config: %w", err)
	}
	if raw == nil {
		raw = map[string]any{}
	}
	if err := migrate(raw); err != nil {
		return Config{}, err
	}
	encoded, err := json.Marshal(raw)
	if err != nil {
		return Config{}, fmt.Errorf("normalize config: %w", err)
	}
	var cfg Config
	if err := json.Unmarshal(encoded, &cfg); err != nil {
		return Config{}, fmt.Errorf("decode config model: %w", err)
	}
	cfg.Raw = raw
	return cfg, nil
}

func (s Store) Save(cfg Config) error {
	if cfg.Raw == nil {
		cfg.Raw = map[string]any{}
	}
	cfg.Raw["schemaVersion"] = CurrentSchemaVersion
	cfg.Raw["channels"] = cfg.Channels
	cfg.Raw["tags"] = cfg.Tags
	b, err := json.MarshalIndent(cfg.Raw, "", "  ")
	if err != nil {
		return fmt.Errorf("encode config: %w", err)
	}
	if err := os.MkdirAll(s.Dir, 0o750); err != nil {
		return fmt.Errorf("create config directory: %w", err)
	}

	// Write, sync, then rename so a process crash cannot leave a partial JSON
	// document at the canonical path.
	tmp, err := os.CreateTemp(s.Dir, ".config-*.json")
	if err != nil {
		return fmt.Errorf("create config temp file: %w", err)
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)
	if err := tmp.Chmod(0o640); err != nil {
		_ = tmp.Close()
		return fmt.Errorf("set config permissions: %w", err)
	}
	if _, err := tmp.Write(bytes.TrimSpace(b)); err != nil {
		_ = tmp.Close()
		return fmt.Errorf("write config temp file: %w", err)
	}
	if err := tmp.Sync(); err != nil {
		_ = tmp.Close()
		return fmt.Errorf("sync config temp file: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("close config temp file: %w", err)
	}
	if err := os.Rename(tmpName, s.Path); err != nil {
		return fmt.Errorf("replace config: %w", err)
	}
	return nil
}

func migrate(raw map[string]any) error {
	version := 1
	if v, ok := raw["schemaVersion"].(float64); ok && v > 0 {
		version = int(v)
	}
	if version > CurrentSchemaVersion {
		return fmt.Errorf("config schema %d is newer than supported schema %d", version, CurrentSchemaVersion)
	}
	// v1 -> v2 currently only records the version. Unknown fields remain in Raw.
	raw["schemaVersion"] = CurrentSchemaVersion
	return nil
}
