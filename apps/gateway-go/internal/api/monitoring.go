package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/factorybridge/iotconnector/gateway-go/internal/acquisition"
	"github.com/factorybridge/iotconnector/gateway-go/internal/domain"
	"github.com/factorybridge/iotconnector/gateway-go/internal/storage"
)

type historyPoint struct {
	TS    int64   `json:"ts"`
	Value float64 `json:"value"`
}

type persistedHistoryPoint struct {
	TagID string `json:"tagId"`
	historyPoint
}

type historyStore struct {
	mu     sync.RWMutex
	values map[string][]historyPoint
	state  *stateStore
}

// newHistoryStore 从 SQLite 恢复最近数据；legacyPath 是旧 history.jsonl，库为空时导入一次。
// 原实现每个样本打开、追加、fsync、关闭一次文件，且文件从不轮转（C3）。
func newHistoryStore(state *stateStore, legacyPath string) *historyStore {
	return &historyStore{values: state.loadHistory(context.Background(), legacyPath), state: state}
}

func (h *historyStore) add(sample acquisition.Sample) {
	if sample.Value.Number == nil {
		return
	}
	h.mu.Lock()
	point := historyPoint{TS: sample.SampledAt, Value: *sample.Value.Number}
	points := append(h.values[sample.TagID], point)
	if len(points) > historyPointsPerTag {
		points = points[len(points)-historyPointsPerTag:]
	}
	h.values[sample.TagID] = points
	h.mu.Unlock()
	h.state.addHistory(sample.TagID, point)
}

func (h *historyStore) query(tagIDs []string, start, end int64) map[string][]historyPoint {
	h.mu.RLock()
	defer h.mu.RUnlock()
	result := make(map[string][]historyPoint, len(tagIDs))
	for _, tagID := range tagIDs {
		for _, point := range h.values[tagID] {
			if (start == 0 || point.TS >= start) && (end == 0 || point.TS <= end) {
				result[tagID] = append(result[tagID], point)
			}
		}
	}
	return result
}

type alarmRule struct {
	ID             string  `json:"id"`
	TagID          string  `json:"tagId"`
	Kind           string  `json:"kind"`
	Threshold      float64 `json:"threshold"`
	Reference      float64 `json:"reference,omitempty"`
	Hysteresis     float64 `json:"hysteresis"`
	MinIntervalSec float64 `json:"minIntervalSec,omitempty"`
	Enabled        bool    `json:"enabled"`
	Message        string  `json:"message,omitempty"`
}

type alarmEvent struct {
	ID        string         `json:"id"`
	RuleID    string         `json:"ruleId"`
	TagID     string         `json:"tagId"`
	TagName   string         `json:"tagName"`
	Channel   string         `json:"channel"`
	State     string         `json:"state"`
	Kind      string         `json:"kind"`
	Threshold float64        `json:"threshold"`
	Value     float64        `json:"value"`
	TS        int64          `json:"ts"`
	Message   string         `json:"message,omitempty"`
	Ack       map[string]any `json:"ack,omitempty"`
	ActiveID  string         `json:"activeId,omitempty"`
}

type alarmManager struct {
	mu              sync.RWMutex
	rules           []alarmRule
	active          map[string]alarmEvent
	history         []alarmEvent // 最近 alarmHistoryLimit 条，新的在前；完整历史在 SQLite
	state           *stateStore
	last            map[string]float64
	onEvent         func(alarmEvent)
	stormLimit      int
	stormHits       []time.Time
	stormSuppressed int
}

func (a *alarmManager) recordLocked(event alarmEvent) {
	a.history = append([]alarmEvent{event}, a.history...)
	if len(a.history) > alarmHistoryLimit {
		a.history = a.history[:alarmHistoryLimit]
	}
	a.state.saveAlarmEvent(event)
}

func newAlarmManager(raw any) *alarmManager {
	manager := &alarmManager{active: make(map[string]alarmEvent), last: make(map[string]float64), stormLimit: 100}
	if rawMap, ok := raw.(map[string]any); ok {
		if value, ok := rawMap["stormLimitPerMin"].(float64); ok && value >= 1 {
			manager.stormLimit = int(value)
		}
	}
	if data, ok := raw.([]any); ok {
		for _, item := range data {
			encoded, _ := json.Marshal(item)
			var rule alarmRule
			if json.Unmarshal(encoded, &rule) == nil && rule.ID != "" {
				manager.rules = append(manager.rules, rule)
			}
		}
	}
	return manager
}

func (a *alarmManager) rulesSnapshot() []alarmRule {
	a.mu.RLock()
	defer a.mu.RUnlock()
	return append([]alarmRule(nil), a.rules...)
}

func (a *alarmManager) evaluate(tag domain.Tag, sample acquisition.Sample) {
	if sample.Value.Number == nil || sample.Quality == acquisition.QualityBad {
		return
	}
	value := *sample.Value.Number
	a.mu.Lock()
	defer a.mu.Unlock()
	for _, rule := range a.rules {
		if !rule.Enabled || rule.TagID != tag.ID {
			continue
		}
		active, isActive := a.active[rule.ID]
		trigger := false
		clear := false
		switch rule.Kind {
		case "low":
			trigger = !isActive && value < rule.Threshold
			clear = isActive && value > rule.Threshold+rule.Hysteresis
		case "deviation":
			deviation := abs(value - rule.Reference)
			trigger = !isActive && deviation > rule.Threshold
			clear = isActive && deviation < rule.Threshold-rule.Hysteresis
		case "roc":
			previous, exists := a.last[rule.ID]
			a.last[rule.ID] = value
			trigger = exists && !isActive && abs(value-previous) > rule.Threshold
			clear = exists && isActive && abs(value-previous) < rule.Threshold-rule.Hysteresis
		default:
			trigger = !isActive && value > rule.Threshold
			clear = isActive && value < rule.Threshold-rule.Hysteresis
		}
		if trigger {
			now := time.Now()
			cutoff := now.Add(-time.Minute)
			kept := managerHits(a.stormHits, cutoff)
			a.stormHits = kept
			if a.stormLimit > 0 && len(a.stormHits) >= a.stormLimit {
				a.stormSuppressed++
				continue
			}
			a.stormHits = append(a.stormHits, now)
			event := alarmEvent{ID: newID("alm_"), RuleID: rule.ID, TagID: tag.ID, TagName: tag.Name, Channel: tag.ChannelID, State: "Active", Kind: rule.Kind, Threshold: rule.Threshold, Value: value, TS: time.Now().UnixMilli(), Message: rule.Message}
			a.active[rule.ID] = event
			a.recordLocked(event)
			if a.onEvent != nil {
				a.onEvent(event)
			}
		} else if clear {
			// 清除事件用新 ID：持久化按 ID 存储，复用激活事件的 ID 会覆盖激活记录，历史里只剩一条。
			// ActiveID 指回被清除的激活事件，供界面关联。
			event := active
			event.ActiveID = active.ID
			event.ID = newID("alm_")
			event.State, event.Value, event.TS = "Cleared", value, time.Now().UnixMilli()
			delete(a.active, rule.ID)
			a.recordLocked(event)
			if a.onEvent != nil {
				a.onEvent(event)
			}
		}
	}
}

func managerHits(values []time.Time, cutoff time.Time) []time.Time {
	kept := values[:0]
	for _, value := range values {
		if value.After(cutoff) {
			kept = append(kept, value)
		}
	}
	return kept
}

func abs(value float64) float64 {
	if value < 0 {
		return -value
	}
	return value
}

func (s *Server) history(w http.ResponseWriter, r *http.Request) {
	ids := strings.Split(r.URL.Query().Get("tagIds"), ",")
	start, _ := strconv.ParseInt(r.URL.Query().Get("start"), 10, 64)
	end, _ := strconv.ParseInt(r.URL.Query().Get("end"), 10, 64)
	series := make([]map[string]any, 0, len(ids))
	remote := map[string][]historyPoint(nil)
	if s.storage != nil && s.storage.Enabled() {
		queryTags := make([]storage.QueryTag, 0, len(ids))
		for _, id := range ids {
			for _, tag := range s.cfg().Tags {
				if tag.ID == id {
					queryTags = append(queryTags, storage.QueryTag{ID: tag.ID, Name: tag.Name})
					break
				}
			}
		}
		if points, err := s.storage.QueryHistory(r.Context(), queryTags, start, end); err == nil {
			remote = make(map[string][]historyPoint, len(points))
			for id, values := range points {
				for _, point := range values {
					remote[id] = append(remote[id], historyPoint{TS: point.TS, Value: point.Value})
				}
			}
		}
	}
	for _, id := range ids {
		if id == "" {
			continue
		}
		points := remote[id]
		if remote == nil {
			points = s.historyStore.query([]string{id}, start, end)[id]
		}
		data := make([]map[string]any, 0, len(points))
		for _, point := range points {
			data = append(data, map[string]any{"t": time.UnixMilli(point.TS).UTC().Format(time.RFC3339), "avg": point.Value, "min": point.Value, "max": point.Value, "n": 1})
		}
		series = append(series, map[string]any{"tagId": id, "points": data, "stats": historyStats(points)})
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "start": start, "end": end, "intervalSec": 0, "series": series})
}

func historyStats(points []historyPoint) map[string]any {
	if len(points) == 0 {
		return map[string]any{"min": nil, "max": nil, "avg": nil, "stdDev": nil, "count": 0}
	}
	min, max, total := points[0].Value, points[0].Value, 0.0
	for _, point := range points {
		if point.Value < min {
			min = point.Value
		}
		if point.Value > max {
			max = point.Value
		}
		total += point.Value
	}
	return map[string]any{"min": min, "max": max, "avg": total / float64(len(points)), "stdDev": nil, "count": len(points)}
}

func (s *Server) alarmResponse(w http.ResponseWriter, r *http.Request) {
	s.alarms.mu.RLock()
	active := make([]alarmEvent, 0, len(s.alarms.active))
	for _, event := range s.alarms.active {
		active = append(active, event)
	}
	history := append([]alarmEvent(nil), s.alarms.history...)
	s.alarms.mu.RUnlock()
	writeJSON(w, http.StatusOK, map[string]any{"rules": s.alarms.rulesSnapshot(), "active": active, "history": history})
}

func (s *Server) saveAlarmRulesLocked() error {
	rules := s.alarms.rulesSnapshot()
	items := make([]any, 0, len(rules))
	for _, rule := range rules {
		items = append(items, rule)
	}
	return s.commitRawLocked("alarms", items)
}

func (s *Server) createAlarm(w http.ResponseWriter, r *http.Request) {
	var rule alarmRule
	if err := json.NewDecoder(r.Body).Decode(&rule); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid alarm JSON"})
		return
	}
	rule.ID = fmt.Sprintf("alarm-%d", time.Now().UnixNano())
	if rule.TagID == "" || rule.Threshold == 0 && rule.Kind == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "tagId, kind and threshold are required"})
		return
	}
	if rule.Kind == "" {
		rule.Kind = "high"
	}
	s.configMu.Lock()
	s.alarms.mu.Lock()
	s.alarms.rules = append(s.alarms.rules, rule)
	s.alarms.mu.Unlock()
	err := s.saveAlarmRulesLocked()
	s.configMu.Unlock()
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusCreated, rule)
}

func (s *Server) updateAlarm(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("alarmID")
	var patch map[string]any
	if err := json.NewDecoder(r.Body).Decode(&patch); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid alarm JSON"})
		return
	}
	s.configMu.Lock()
	var result alarmRule
	found := false
	s.alarms.mu.Lock()
	for i := range s.alarms.rules {
		if s.alarms.rules[i].ID == id {
			encoded, _ := json.Marshal(patch)
			_ = json.Unmarshal(encoded, &s.alarms.rules[i])
			result, found = s.alarms.rules[i], true
			break
		}
	}
	s.alarms.mu.Unlock()
	err := s.saveAlarmRulesLocked()
	s.configMu.Unlock()
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": err.Error()})
		return
	}
	if !found {
		writeJSON(w, http.StatusNotFound, map[string]any{"error": "alarm rule not found"})
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (s *Server) deleteAlarm(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("alarmID")
	s.configMu.Lock()
	s.alarms.mu.Lock()
	found := false
	for i := range s.alarms.rules {
		if s.alarms.rules[i].ID == id {
			s.alarms.rules = append(s.alarms.rules[:i], s.alarms.rules[i+1:]...)
			delete(s.alarms.active, id)
			found = true
			break
		}
	}
	s.alarms.mu.Unlock()
	err := s.saveAlarmRulesLocked()
	s.configMu.Unlock()
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": err.Error()})
		return
	}
	if !found {
		writeJSON(w, http.StatusNotFound, map[string]any{"error": "alarm rule not found"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (s *Server) alarmHistory(w http.ResponseWriter, r *http.Request) {
	page, _ := strconv.Atoi(r.URL.Query().Get("page"))
	pageSize, _ := strconv.Atoi(r.URL.Query().Get("pageSize"))
	if page < 0 {
		page = 0
	}
	if pageSize <= 0 || pageSize > 500 {
		pageSize = 50
	}
	if s.alarms.state != nil {
		events, total, err := s.alarms.state.queryAlarmHistory(r.Context(), page, pageSize)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]any{"ok": false, "error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "events": events, "total": total, "page": page, "pageSize": pageSize})
		return
	}
	s.alarms.mu.RLock()
	history := append([]alarmEvent(nil), s.alarms.history...)
	s.alarms.mu.RUnlock()
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "events": history, "total": len(history), "page": 0, "pageSize": len(history)})
}

func (s *Server) ackAlarm(w http.ResponseWriter, r *http.Request) {
	eventID := r.PathValue("eventID")
	var request struct {
		Note string `json:"note"`
	}
	_ = json.NewDecoder(r.Body).Decode(&request)
	actor := actor(r)
	s.alarms.mu.Lock()
	var result *alarmEvent
	for i := range s.alarms.history {
		if s.alarms.history[i].ID == eventID {
			s.alarms.history[i].Ack = map[string]any{"user": actor, "ts": time.Now().UnixMilli(), "note": request.Note}
			copy := s.alarms.history[i]
			result = &copy
			s.alarms.state.saveAlarmEvent(copy)
			break
		}
	}
	if result != nil {
		for ruleID, event := range s.alarms.active {
			if event.ID == eventID {
				event.Ack = result.Ack
				s.alarms.active[ruleID] = event
			}
		}
	}
	s.alarms.mu.Unlock()
	if result == nil {
		writeJSON(w, http.StatusNotFound, map[string]any{"error": "alarm event not found"})
		return
	}
	writeJSON(w, http.StatusOK, result)
}
