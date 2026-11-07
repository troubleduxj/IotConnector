package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"regexp"
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

	channels := len(cfg.Channels)
	tags := len(cfg.Tags)
	s.recordAudit(r, actor(r), "system.config-backup", "config", map[string]any{"channels": channels, "tags": tags})

	w.Header().Set("Content-Disposition", `attachment; filename="factorybridge-config.json"`)
	writeJSON(w, http.StatusOK, map[string]any{
		"format":     configBackupFormat,
		"exportedAt": time.Now().UTC().Format(time.RFC3339),
		"config":     raw,
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

	s.recordAudit(r, actor(r), "system.config-restore", "config", map[string]any{"channels": len(channels), "tags": len(tags)})
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "counts": map[string]any{"channels": len(channels), "tags": len(tags)}})
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
