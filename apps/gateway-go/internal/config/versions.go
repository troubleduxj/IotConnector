package config

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"time"
)

// 配置版本存库（G6，方案 A）。
//
// 采集配置（通道、位号、告警、脚本、北向、通知……）整份存进 gateway.db 的 config_versions 表，
// 每次保存新增一个版本，最新版本为准。config.json 每次保存都同步写出，作为镜像：
// 便于查看、旧版本二进制回滚、外部工具读取。
//
// 启动时：
//   - 库中没有版本：导入现有 config.json（没有则为空配置）作为第一个版本；
//   - 库中有版本，config.json 内容与最新版本不同（停机时被手工改过）：导入为新版本并提示，
//     而不是用库里的旧内容静默覆盖手工修改；
//   - config.json 不存在或无法解析：以库为准，并重写镜像。

// DefaultKeepVersions 是保留的历史版本数。
const DefaultKeepVersions = 200

// Version 是一个配置版本的摘要。
type Version struct {
	Version int64     `json:"version"`
	SavedAt time.Time `json:"savedAt"`
	Actor   string    `json:"actor"`
	SHA256  string    `json:"sha256"`
}

func (s *Store) dbEnabled() bool { return s.db != nil }

// ImportedEditedFile 报告最近一次 Load 是否把手工改过的 config.json 导入为新版本。
func (s *Store) ImportedEditedFile() bool { return s.importedEdit }

func encodeBody(cfg Config) ([]byte, error) {
	raw := map[string]any{}
	for key, value := range cfg.Raw {
		raw[key] = value
	}
	raw["schemaVersion"] = CurrentSchemaVersion
	raw["channels"] = cfg.Channels
	raw["tags"] = cfg.Tags
	b, err := json.MarshalIndent(raw, "", "  ")
	if err != nil {
		return nil, fmt.Errorf("encode config: %w", err)
	}
	return bytes.TrimSpace(b), nil
}

func digest(body []byte) string {
	sum := sha256.Sum256(body)
	return hex.EncodeToString(sum[:])
}

// canonical 把任意 JSON 配置文本归一化（解析、迁移、重新编码），用于比较内容是否相同。
func canonical(body []byte) ([]byte, Config, error) {
	cfg, err := parse(body)
	if err != nil {
		return nil, Config{}, err
	}
	out, err := encodeBody(cfg)
	return out, cfg, err
}

func (s *Store) latest(ctx context.Context) ([]byte, string, bool, error) {
	var body, sum string
	err := s.db.QueryRowContext(ctx, `SELECT body, sha256 FROM config_versions ORDER BY version DESC LIMIT 1`).Scan(&body, &sum)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, "", false, nil
	}
	if err != nil {
		return nil, "", false, fmt.Errorf("read latest config version: %w", err)
	}
	return []byte(body), sum, true, nil
}

// insertVersion 写入一个新版本（内容与最新版本相同时跳过），并清理超出保留数的旧版本。
func (s *Store) insertVersion(ctx context.Context, body []byte, actor string) error {
	sum := digest(body)
	if _, latestSum, ok, err := s.latest(ctx); err != nil {
		return err
	} else if ok && latestSum == sum {
		return nil
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO config_versions(saved_at, actor, sha256, body) VALUES (?, ?, ?, ?)`,
		time.Now().UnixMilli(), actor, sum, string(body)); err != nil {
		_ = tx.Rollback()
		return fmt.Errorf("save config version: %w", err)
	}
	keep := s.keepVersions
	if keep <= 0 {
		keep = DefaultKeepVersions
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM config_versions WHERE version <= (SELECT MAX(version) FROM config_versions) - ?`, keep); err != nil {
		_ = tx.Rollback()
		return fmt.Errorf("prune config versions: %w", err)
	}
	return tx.Commit()
}

// loadDB 是启用数据库时的 Load。
func (s *Store) loadDB() (Config, error) {
	ctx := context.Background()
	s.importedEdit = false
	latestBody, _, haveDB, err := s.latest(ctx)
	if err != nil {
		return Config{}, err
	}
	fileCfg, haveFile, fileErr := s.loadFile()

	if !haveDB {
		if fileErr != nil {
			return Config{}, fileErr // 首次导入时文件损坏：不能静默当成空配置
		}
		cfg := fileCfg
		if !haveFile {
			cfg = Config{SchemaVersion: CurrentSchemaVersion, Raw: map[string]any{}}
		}
		body, err := encodeBody(cfg)
		if err != nil {
			return Config{}, err
		}
		if err := s.insertVersion(ctx, body, "import:config.json"); err != nil {
			return Config{}, err
		}
		return parse(body)
	}

	dbBody, dbCfg, err := canonical(latestBody)
	if err != nil {
		return Config{}, fmt.Errorf("latest config version is unreadable: %w", err)
	}
	if haveFile && fileErr == nil {
		fileBody, err := encodeBody(fileCfg)
		if err != nil {
			return Config{}, err
		}
		if !bytes.Equal(fileBody, dbBody) {
			if err := s.insertVersion(ctx, fileBody, "import:config.json"); err != nil {
				return Config{}, err
			}
			s.importedEdit = true
			return parse(fileBody)
		}
		return dbCfg, nil
	}
	// 镜像缺失或损坏：以库为准并重写。
	if err := s.writeFile(dbCfg); err != nil {
		return Config{}, err
	}
	return dbCfg, nil
}

// Versions 返回最近 limit 个版本，新的在前。
func (s *Store) Versions(ctx context.Context, limit int) ([]Version, error) {
	if !s.dbEnabled() {
		return nil, errors.New("config versions need the state database")
	}
	if limit <= 0 {
		limit = 50
	}
	rows, err := s.db.QueryContext(ctx, `SELECT version, saved_at, actor, sha256 FROM config_versions ORDER BY version DESC LIMIT ?`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Version
	for rows.Next() {
		var v Version
		var savedAt int64
		if err := rows.Scan(&v.Version, &savedAt, &v.Actor, &v.SHA256); err != nil {
			return nil, err
		}
		v.SavedAt = time.UnixMilli(savedAt)
		out = append(out, v)
	}
	return out, rows.Err()
}

// VersionBody 返回指定版本的完整 JSON，可直接作为 config.json 或经备份恢复接口导入。
func (s *Store) VersionBody(ctx context.Context, version int64) (string, error) {
	if !s.dbEnabled() {
		return "", errors.New("config versions need the state database")
	}
	var body string
	err := s.db.QueryRowContext(ctx, `SELECT body FROM config_versions WHERE version = ?`, version).Scan(&body)
	if errors.Is(err, sql.ErrNoRows) {
		return "", fmt.Errorf("config version %d not found", version)
	}
	return body, err
}
