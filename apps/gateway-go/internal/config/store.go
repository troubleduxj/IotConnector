package config

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"github.com/factorybridge/iotconnector/gateway-go/internal/db"
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
	// db 非空时以 gateway.db 中的版本为准，config.json 为镜像（G6）。
	db           *db.DB
	keepVersions int
	importedEdit bool
}

// NewStore 只读写 config.json（测试、离线工具，以及未打开状态库的场景）。
func NewStore(dir string) Store {
	return Store{Dir: dir, Path: filepath.Join(dir, "config.json")}
}

// NewStoreDB 以 gateway.db 为准保存配置版本，config.json 每次同步写出（G6）。
func NewStoreDB(dir string, database *db.DB) *Store {
	return &Store{Dir: dir, Path: filepath.Join(dir, "config.json"), db: database, keepVersions: DefaultKeepVersions}
}

func (s *Store) Load() (Config, error) {
	if s.dbEnabled() {
		return s.loadDB()
	}
	cfg, ok, err := s.loadFile()
	if err != nil {
		return Config{}, err
	}
	if !ok {
		return Config{SchemaVersion: CurrentSchemaVersion, Raw: map[string]any{}}, nil
	}
	return cfg, nil
}

// loadFile 读取 config.json；文件不存在时 ok=false、err=nil。
func (s *Store) loadFile() (Config, bool, error) {
	b, err := os.ReadFile(s.Path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return Config{}, false, nil
		}
		return Config{}, false, fmt.Errorf("read config: %w", err)
	}
	cfg, err := parse(b)
	if err != nil {
		return Config{}, true, err
	}
	return cfg, true, nil
}

// parse 解析配置 JSON 并执行 schema 迁移；未知字段保留在 Raw。
func parse(b []byte) (Config, error) {
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

// Save 保存配置：启用数据库时先写入新版本，再更新 config.json 镜像。
func (s *Store) Save(cfg Config) error { return s.SaveAs(cfg, "") }

// SaveAs 与 Save 相同，并记录修改者（用户名或来源，如 "api"、"restore"）。
func (s *Store) SaveAs(cfg Config, actor string) error {
	if s.dbEnabled() {
		body, err := encodeBody(cfg)
		if err != nil {
			return err
		}
		if err := s.insertVersion(context.Background(), body, actor); err != nil {
			return err
		}
	}
	return s.writeFile(cfg)
}

// writeFile 原子写出 config.json。
func (s *Store) writeFile(cfg Config) error {
	b, err := encodeBody(cfg)
	if err != nil {
		return err
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
	if _, err := tmp.Write(b); err != nil {
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

// Clone 返回深拷贝。运行时把已发布的配置视为只读：写入方先 Clone、修改副本、保存，
// 再整体替换指针，读取方因此无需加锁，也不会遇到 map 被并发写入（C2）。
func (c Config) Clone() Config {
	out := Config{SchemaVersion: c.SchemaVersion}
	if c.Channels != nil {
		out.Channels = make([]domain.Channel, len(c.Channels))
		for i, channel := range c.Channels {
			channel.Params = DeepCopyMap(channel.Params)
			out.Channels[i] = channel
		}
	}
	if c.Tags != nil {
		out.Tags = make([]domain.Tag, len(c.Tags))
		for i, tag := range c.Tags {
			if tag.EngMin != nil {
				v := *tag.EngMin
				tag.EngMin = &v
			}
			if tag.EngMax != nil {
				v := *tag.EngMax
				tag.EngMax = &v
			}
			out.Tags[i] = tag
		}
	}
	out.Raw = DeepCopyMap(c.Raw)
	return out
}

// DeepCopyMap 递归复制 JSON 形态的 map/slice；其他类型按值保留。
func DeepCopyMap(in map[string]any) map[string]any {
	if in == nil {
		return nil
	}
	out := make(map[string]any, len(in))
	for key, value := range in {
		out[key] = deepCopyValue(value)
	}
	return out
}

func deepCopyValue(value any) any {
	switch typed := value.(type) {
	case map[string]any:
		return DeepCopyMap(typed)
	case []any:
		out := make([]any, len(typed))
		for i, item := range typed {
			out[i] = deepCopyValue(item)
		}
		return out
	case []map[string]any:
		out := make([]map[string]any, len(typed))
		for i, item := range typed {
			out[i] = DeepCopyMap(item)
		}
		return out
	default:
		return value
	}
}
