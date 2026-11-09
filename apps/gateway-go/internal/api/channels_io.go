package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/factorybridge/iotconnector/gateway-go/internal/audit"
	"github.com/factorybridge/iotconnector/gateway-go/internal/config"
	"github.com/factorybridge/iotconnector/gateway-go/internal/domain"
	"github.com/factorybridge/iotconnector/gateway-go/internal/version"
)

// 通道导入导出、诊断包、OpenAPI 文档。

const channelExportFormat = "factorybridge-channel@1"

// exportChannel 导出一个通道及其点位。敏感参数经 redactSecrets 处理，不以明文输出。
func (s *Server) exportChannel(w http.ResponseWriter, r *http.Request) {
	channelID := r.PathValue("channelID")
	current := s.cfg()

	var found *domain.Channel
	for i := range current.Channels {
		if current.Channels[i].ID == channelID {
			found = &current.Channels[i]
			break
		}
	}
	if found == nil {
		writeJSON(w, http.StatusNotFound, map[string]any{"ok": false, "error": "channel not found"})
		return
	}

	raw, err := json.Marshal(found)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	var channelMap map[string]any
	if err := json.Unmarshal(raw, &channelMap); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	redacted := redactSecrets(channelMap)

	tags := make([]domain.Tag, 0)
	for _, tag := range current.Tags {
		if tag.ChannelID == channelID {
			tags = append(tags, tag)
		}
	}

	filename := sanitizeFilename(found.Name) + ".channel.json"
	w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="%s"`, filename))
	writeJSON(w, http.StatusOK, map[string]any{
		"format":     channelExportFormat,
		"exportedAt": time.Now().UTC().Format(time.RFC3339),
		"channel":    redacted,
		"tags":       tags,
	})

	s.recordAudit(r, actor(r), "channel.export", channelID, map[string]any{"tags": len(tags)})
}

// sanitizeFilename 把 [A-Za-z0-9_-] 之外的每个字符替换为 "_"。
func sanitizeFilename(name string) string {
	var b strings.Builder
	for _, ch := range name {
		switch {
		case ch >= 'a' && ch <= 'z', ch >= 'A' && ch <= 'Z', ch >= '0' && ch <= '9', ch == '_', ch == '-':
			b.WriteRune(ch)
		default:
			b.WriteRune('_')
		}
	}
	return b.String()
}

type channelImportBody struct {
	Channel domain.Channel `json:"channel"`
	Tags    []domain.Tag   `json:"tags"`
}

// importChannel 导入 exportChannel 产出的通道包。通道和点位总是分配新 ID。
func (s *Server) importChannel(w http.ResponseWriter, r *http.Request) {
	var body channelImportBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": "invalid JSON"})
		return
	}

	channel := body.Channel
	if channel.Name == "" || channel.Protocol == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": "channel.name & channel.protocol required"})
		return
	}
	if channel.Host == "" || channel.Port < 1 || channel.Port > 65535 {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": "channel.host required and port must be 1..65535"})
		return
	}

	var details []string
	for i, tag := range body.Tags {
		if tag.Name == "" || tag.Address == "" {
			if len(details) < 20 {
				details = append(details, fmt.Sprintf("tags[%d]: name and address required", i))
			}
		}
	}
	if len(details) > 0 {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": "点位地址校验失败", "details": details})
		return
	}

	if channel.Params == nil {
		channel.Params = map[string]any{}
	}
	preserveSecrets(channel.Params)
	if channel.PollIntervalMs == 0 {
		channel.PollIntervalMs = 1000
	} else if channel.PollIntervalMs < 50 {
		channel.PollIntervalMs = 50
	}
	channel.ID = newID("ch_")

	newTags := make([]domain.Tag, 0, len(body.Tags))
	for _, tag := range body.Tags {
		tag.ID = newID("tag_")
		tag.ChannelID = channel.ID
		newTags = append(newTags, tag)
	}

	s.configMu.Lock()
	for _, existing := range s.cfg().Channels {
		if existing.Name == channel.Name {
			s.configMu.Unlock()
			writeJSON(w, http.StatusConflict, map[string]any{"ok": false, "error": "通道名已存在: " + channel.Name})
			return
		}
	}
	err := s.persistConfigLocked(func(c *config.Config) {
		c.Channels = append(c.Channels, channel)
		c.Tags = append(c.Tags, newTags...)
	})
	s.configMu.Unlock()
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"ok": false, "error": err.Error()})
		return
	}

	writeJSON(w, http.StatusCreated, map[string]any{"channel": channel, "importedTags": len(newTags)})
	s.recordAudit(r, actor(r), "channel.import", channel.ID, map[string]any{"tags": len(newTags)})
}

// systemDiag 生成诊断 JSON。不含配置中的凭据和用户口令哈希。
func (s *Server) systemDiag(w http.ResponseWriter, r *http.Request) {
	current := s.cfg()

	alarmCount := 0
	if s.alarms != nil {
		alarmCount = len(s.alarms.rulesSnapshot())
	}

	var channelStatuses any = []any{}
	if s.engine != nil {
		channelStatuses = s.engine.Statuses()
	}

	auditEvents := []audit.Event{}
	if s.audit != nil {
		if events, err := s.audit.Recent(500); err == nil && events != nil {
			auditEvents = events
		}
	}

	w.Header().Set("Content-Disposition", `attachment; filename="factorybridge-diag.json"`)
	writeJSON(w, http.StatusOK, map[string]any{
		"generatedAt": time.Now().UTC().Format(time.RFC3339),
		"info": map[string]any{
			"build":     version.Info(),
			"uptimeSec": int(time.Since(s.startedAt).Seconds()),
			"counts": map[string]any{
				"channels": len(current.Channels),
				"tags":     len(current.Tags),
				"alarms":   alarmCount,
			},
		},
		"channels": channelStatuses,
		"audit":    auditEvents,
	})
}

// openAPIDoc 从 routePolicies 生成 OpenAPI 3.0.3 文档。
func (s *Server) openAPIDoc(w http.ResponseWriter, r *http.Request) {
	patterns := make([]string, 0, len(routePolicies))
	for pattern := range routePolicies {
		patterns = append(patterns, pattern)
	}
	sort.Strings(patterns)

	paths := map[string]map[string]any{}
	for _, pattern := range patterns {
		parts := strings.SplitN(pattern, " ", 2)
		if len(parts) != 2 {
			continue
		}
		method, path := strings.ToLower(parts[0]), parts[1]
		policy := routePolicies[pattern]

		security := []map[string]any{{"bearerAuth": []string{}}}
		role := string(policy.role)
		if policy.public {
			security = []map[string]any{}
			role = "public"
		}

		if paths[path] == nil {
			paths[path] = map[string]any{}
		}
		paths[path][method] = map[string]any{
			"summary":    pattern,
			"security":   security,
			"x-min-role": role,
			"responses": map[string]any{
				"default": map[string]any{"description": "错误", "content": map[string]any{"application/json": map[string]any{"schema": map[string]any{"$ref": "#/components/schemas/Error"}}}},
			},
		}
	}

	w.Header().Set("Content-Disposition", `attachment; filename="openapi.json"`)
	writeJSON(w, http.StatusOK, map[string]any{
		"openapi": "3.0.3",
		"info": map[string]any{
			"title":   "FactoryBridge Edge Gateway REST API",
			"version": version.Version,
			// F5：/api/v1/... 与 /api/... 等价；错误响应统一为 components.schemas.Error。
			"description": "所有路径也可加版本前缀访问：/api/v1/... 与 /api/... 等价，响应头 API-Version: 1。错误响应统一为 {ok:false, error, code}。",
		},
		"paths": paths,
		"components": map[string]any{
			"securitySchemes": map[string]any{
				"bearerAuth": map[string]any{"type": "http", "scheme": "bearer"},
			},
			"schemas": map[string]any{
				"Error": map[string]any{
					"type":     "object",
					"required": []string{"ok", "error", "code"},
					"properties": map[string]any{
						"ok":    map[string]any{"type": "boolean", "enum": []bool{false}},
						"error": map[string]any{"type": "string", "description": "可读消息"},
						"code":  map[string]any{"type": "string", "description": "机器可读代码，如 bad_request、unauthorized、forbidden、not_found、conflict、internal"},
					},
					"additionalProperties": true,
				},
			},
		},
	})
}
