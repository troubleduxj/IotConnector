package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/factorybridge/iotconnector/gateway-go/internal/config"
	"github.com/factorybridge/iotconnector/gateway-go/internal/domain"
)

// 配置备份恢复、恢复出厂、调度重平衡。

const configBackupFormat = "factorybridge-config@1"

var storageDBNamePattern = regexp.MustCompile(`[^A-Za-z0-9_]`)

// resetRawKeys 是恢复出厂时清空的顶层键；用户与会话存放在 SQLite，不在配置中。
var resetRawKeys = []string{"alarms", "storageTasks", "recipes", "recipeDownloads", "scripts"}

func (s *Server) configBackup(w http.ResponseWriter, r *http.Request) {
	cfg := s.cfg()
	raw := config.DeepCopyMap(cfg.Raw)
	if raw == nil {
		raw = map[string]any{}
	}
	delete(raw, "users")
	raw["schemaVersion"] = config.CurrentSchemaVersion
	raw["channels"] = channelsOrEmpty(cfg.Channels)
	raw["tags"] = tagsOrEmpty(cfg.Tags)

	// 默认不导出口令（口令只写不读，与各配置页一致）：敏感字段置空并带 <key>Set 标记。
	// 迁移到另一台网关需要完整备份时显式加 ?includeSecrets=1，该操作单独记审计。
	includeSecrets := r.URL.Query().Get("includeSecrets") == "1"
	var exported any = raw
	if !includeSecrets {
		var generic map[string]any
		if err := roundTripJSON(raw, &generic); err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]any{"ok": false, "error": err.Error()})
			return
		}
		exported = redactSecrets(generic)
	}

	channels := len(cfg.Channels)
	tags := len(cfg.Tags)
	s.recordAudit(r, actor(r), "system.config-backup", "config", map[string]any{"channels": channels, "tags": tags, "includeSecrets": includeSecrets})

	w.Header().Set("Content-Disposition", `attachment; filename="factorybridge-config.json"`)
	writeJSON(w, http.StatusOK, map[string]any{
		"format":         configBackupFormat,
		"exportedAt":     time.Now().UTC().Format(time.RFC3339),
		"secretsOmitted": !includeSecrets,
		"config":         exported,
	})
}

func (s *Server) configRestore(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Format string         `json:"format"`
		Config map[string]any `json:"config"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": "invalid JSON body"})
		return
	}
	if body.Format != configBackupFormat || body.Config == nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": "body.format 必须为 factorybridge-config@1 且含 config"})
		return
	}
	// 备份默认不含口令：文件里为空的敏感字段沿用本机当前值（通道按 ID 对应），
	// 本机也没有的列在响应 secretsMissing 里，需在界面重新填写。
	var current map[string]any
	{
		cfg := s.cfg()
		snapshot := config.DeepCopyMap(cfg.Raw)
		if snapshot == nil {
			snapshot = map[string]any{}
		}
		snapshot["channels"] = channelsOrEmpty(cfg.Channels)
		snapshot["tags"] = tagsOrEmpty(cfg.Tags)
		if err := roundTripJSON(snapshot, &current); err != nil {
			current = map[string]any{}
		}
	}
	var secretsMissing []string
	restoreSecrets(body.Config, current, "", &secretsMissing)
	sort.Strings(secretsMissing)

	rawChannels, okChannels := body.Config["channels"].([]any)
	rawTags, okTags := body.Config["tags"].([]any)
	if !okChannels || !okTags {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": "config.channels 与 config.tags 必须为数组"})
		return
	}
	var channels []domain.Channel
	if err := roundTripJSON(rawChannels, &channels); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": "config.channels 解析失败: " + err.Error()})
		return
	}
	var tags []domain.Tag
	if err := roundTripJSON(rawTags, &tags); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": "config.tags 解析失败: " + err.Error()})
		return
	}
	channels = channelsOrEmpty(channels)
	tags = tagsOrEmpty(tags)

	raw := config.DeepCopyMap(body.Config)
	delete(raw, "users")

	s.configMu.Lock()
	err := s.persistConfigLocked(func(c *config.Config) {
		c.Channels = channels
		c.Tags = tags
		c.Raw = raw
	})
	s.configMu.Unlock()
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	s.resyncDependentEngines()

	s.recordAudit(r, actor(r), "system.config-restore", "config", map[string]any{"channels": len(channels), "tags": len(tags), "secretsMissing": len(secretsMissing)})
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "counts": map[string]any{"channels": len(channels), "tags": len(tags)}, "secretsMissing": nonNilStrings(secretsMissing)})
}

func (s *Server) factoryReset(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Confirm      string `json:"confirm"`
		PurgeStorage bool   `json:"purgeStorage"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": "invalid JSON body"})
		return
	}
	if body.Confirm != "RESET" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": "body.confirm 必须为 'RESET'"})
		return
	}

	s.configMu.Lock()
	err := s.persistConfigLocked(func(c *config.Config) {
		c.Channels = []domain.Channel{}
		c.Tags = []domain.Tag{}
		raw := config.DeepCopyMap(c.Raw)
		if raw == nil {
			raw = map[string]any{}
		}
		delete(raw, "users")
		for _, key := range resetRawKeys {
			raw[key] = []any{}
		}
		raw["notifications"] = map[string]any{"enabled": false}
		raw["northbound"] = map[string]any{"enabled": false}
		c.Raw = raw
	})
	s.configMu.Unlock()
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	s.resyncDependentEngines()

	storagePurged := false
	storagePurgeError := ""
	if body.PurgeStorage && s.storage != nil && s.storage.Enabled() {
		if err := s.purgeStorage(r.Context()); err != nil {
			storagePurgeError = err.Error()
		} else {
			storagePurged = true
		}
	}

	s.recordAudit(r, actor(r), "system.factory-reset", "config", map[string]any{"purgeStorage": body.PurgeStorage, "storagePurged": storagePurged, "storagePurgeError": storagePurgeError})
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "storagePurged": storagePurged, "storagePurgeError": storagePurgeError})
}

// purgeStorage 删除时序库并重新初始化空库。数据库名只保留 [A-Za-z0-9_]。
func (s *Server) purgeStorage(parent context.Context) error {
	_, database := s.storage.ConfigSummary()
	name := storageDBNamePattern.ReplaceAllString(database, "")
	if name == "" {
		return fmt.Errorf("storage database name is empty after sanitizing")
	}
	ctx, cancel := context.WithTimeout(parent, 30*time.Second)
	defer cancel()
	if err := s.storage.Execute(ctx, "DROP DATABASE IF EXISTS "+name); err != nil {
		return fmt.Errorf("drop database: %w", err)
	}
	if err := s.storage.Init(ctx); err != nil {
		return fmt.Errorf("init storage: %w", err)
	}
	return nil
}

func (s *Server) rebalanceScheduler(w http.ResponseWriter, r *http.Request) {
	cfg := s.cfg()
	if err := s.engine.Reload(r.Context(), engineChannels(*cfg), engineTags(*cfg)); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	reloaded := 0
	for _, channel := range cfg.Channels {
		if channel.Enabled {
			reloaded++
		}
	}
	s.recordAudit(r, actor(r), "scheduler.rebalance", "engine", map[string]any{"reloaded": reloaded})
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "reloaded": reloaded})
}

// resyncDependentEngines 在配置整体替换后，让依赖配置的运行时组件重新加载。
// 调用方不得持有 configMu：脚本与存储任务的同步会再次读取配置。
func (s *Server) resyncDependentEngines() {
	// 告警规则与 createAlarm/updateAlarm 一样由 Raw["alarms"] 解析而来；
	// 已不存在的规则的活动告警一并清除。
	parsed := newAlarmManager(s.cfg().Raw["alarms"])
	s.alarms.mu.Lock()
	ids := make(map[string]struct{}, len(parsed.rules))
	for _, rule := range parsed.rules {
		ids[rule.ID] = struct{}{}
	}
	for id := range s.alarms.active {
		if _, ok := ids[id]; !ok {
			delete(s.alarms.active, id)
		}
	}
	s.alarms.rules = parsed.rules
	s.alarms.stormLimit = parsed.stormLimit
	// 变化率告警的上一次取值与风暴抑制计数属于旧规则集，换规则后一并清零；
	// 否则新规则会拿恢复前的值算变化率，产生误报。（主会话核查时补充）
	s.alarms.last = map[string]float64{}
	s.alarms.stormHits = nil
	s.alarms.stormSuppressed = 0
	s.alarms.mu.Unlock()

	if s.scriptEngine != nil {
		s.scriptEngine.configure()
	}
	if s.taskEngine != nil {
		s.taskEngine.sync()
	}
}

func roundTripJSON(in any, out any) error {
	encoded, err := json.Marshal(in)
	if err != nil {
		return err
	}
	return json.Unmarshal(encoded, out)
}

func channelsOrEmpty(channels []domain.Channel) []domain.Channel {
	if channels == nil {
		return []domain.Channel{}
	}
	return channels
}

func tagsOrEmpty(tags []domain.Tag) []domain.Tag {
	if tags == nil {
		return []domain.Tag{}
	}
	return tags
}

// restoreSecrets 原地处理待恢复的配置：去掉 <key>Set 标记；敏感字段为空时取 current 同一路径的值。
// 数组元素带 id 时按 id 对应（通道、位号），否则按下标。仍为空、且备份标记"原本已设置"的，记入 missing。
func restoreSecrets(incoming, current map[string]any, path string, missing *[]string) {
	for key, value := range incoming {
		if strings.HasSuffix(key, "Set") && isSecretKey(strings.TrimSuffix(key, "Set")) {
			continue
		}
		child := key
		if path != "" {
			child = path + "." + key
		}
		if isSecretKey(key) {
			if text, _ := value.(string); text != "" {
				continue
			}
			if existing, ok := current[key].(string); ok && existing != "" {
				incoming[key] = existing
				continue
			}
			if wasSet, _ := incoming[key+"Set"].(bool); wasSet {
				*missing = append(*missing, child)
			}
			continue
		}
		switch typed := value.(type) {
		case map[string]any:
			next, _ := current[key].(map[string]any)
			if next == nil {
				next = map[string]any{}
			}
			restoreSecrets(typed, next, child, missing)
		case []any:
			old, _ := current[key].([]any)
			byID := map[string]map[string]any{}
			for _, item := range old {
				if m, ok := item.(map[string]any); ok {
					if id, ok := m["id"].(string); ok && id != "" {
						byID[id] = m
					}
				}
			}
			for i, item := range typed {
				m, ok := item.(map[string]any)
				if !ok {
					continue
				}
				var match map[string]any
				label := fmt.Sprintf("%s[%d]", child, i)
				if id, ok := m["id"].(string); ok && id != "" {
					match = byID[id]
					label = fmt.Sprintf("%s[%s]", child, id)
				} else if i < len(old) {
					match, _ = old[i].(map[string]any)
				}
				if match == nil {
					match = map[string]any{}
				}
				restoreSecrets(m, match, label, missing)
			}
		}
	}
	for key := range incoming {
		if strings.HasSuffix(key, "Set") && isSecretKey(strings.TrimSuffix(key, "Set")) {
			delete(incoming, key)
		}
	}
}

func nonNilStrings(values []string) []string {
	if values == nil {
		return []string{}
	}
	return values
}
