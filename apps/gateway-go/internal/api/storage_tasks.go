package api

import (
	"context"
	"encoding/json"
	"fmt"
	"github.com/factorybridge/iotconnector/gateway-go/internal/config"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/factorybridge/iotconnector/gateway-go/internal/acquisition"
)

func (s *Server) storageTasksSnapshot() []map[string]any {
	items, ok := s.cfg().Raw["storageTasks"].([]any)
	if !ok {
		return []map[string]any{}
	}
	result := make([]map[string]any, 0, len(items))
	for _, item := range items {
		if task, ok := item.(map[string]any); ok {
			result = append(result, config.DeepCopyMap(task))
		}
	}
	return result
}

func cloneMap(input map[string]any) map[string]any {
	result := make(map[string]any, len(input))
	for key, value := range input {
		result[key] = value
	}
	return result
}

func (s *Server) saveStorageTasks(tasks []map[string]any) error {
	items := make([]any, 0, len(tasks))
	for _, task := range tasks {
		items = append(items, task)
	}
	return s.commitRawLocked("storageTasks", items)
}

func (s *Server) storageTasks(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, s.storageTasksSnapshot())
}

func (s *Server) storageTaskStats(w http.ResponseWriter, r *http.Request) {
	result := s.taskEngine.stats()
	writeJSON(w, http.StatusOK, result)
}

func (s *Server) createStorageTask(w http.ResponseWriter, r *http.Request) {
	var body map[string]any
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": "invalid storage task JSON"})
		return
	}
	if strings.TrimSpace(stringValue(body["name"])) == "" || strings.TrimSpace(stringValue(body["tableName"])) == "" || body["trigger"] == nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": "name, tableName & trigger required"})
		return
	}
	task := cloneMap(body)
	task["id"] = fmt.Sprintf("stk_%d", time.Now().UnixMilli())
	if _, ok := task["enabled"]; !ok {
		task["enabled"] = true
	}
	if _, ok := task["mappings"]; !ok {
		task["mappings"] = []any{}
	}
	s.configMu.Lock()
	tasks := s.storageTasksSnapshot()
	tasks = append(tasks, task)
	err := s.saveStorageTasks(tasks)
	s.configMu.Unlock()
	s.taskEngine.sync()
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	writeJSON(w, http.StatusCreated, task)
}

func (s *Server) updateStorageTask(w http.ResponseWriter, r *http.Request) {
	var patch map[string]any
	if err := json.NewDecoder(r.Body).Decode(&patch); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": "invalid storage task JSON"})
		return
	}
	id := r.PathValue("taskID")
	s.configMu.Lock()
	tasks := s.storageTasksSnapshot()
	var result map[string]any
	for i, task := range tasks {
		if task["id"] == id {
			for key, value := range patch {
				if key != "id" {
					task[key] = value
				}
			}
			tasks[i], result = task, task
			break
		}
	}
	if result == nil {
		s.configMu.Unlock()
		writeJSON(w, http.StatusNotFound, map[string]any{"ok": false, "error": "task not found"})
		return
	}
	err := s.saveStorageTasks(tasks)
	s.configMu.Unlock()
	s.taskEngine.sync()
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (s *Server) deleteStorageTask(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("taskID")
	s.configMu.Lock()
	tasks := s.storageTasksSnapshot()
	filtered := make([]map[string]any, 0, len(tasks))
	found := false
	for _, task := range tasks {
		if task["id"] == id {
			found = true
			continue
		}
		filtered = append(filtered, task)
	}
	err := s.saveStorageTasks(filtered)
	s.configMu.Unlock()
	s.taskEngine.sync()
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	if !found {
		writeJSON(w, http.StatusNotFound, map[string]any{"ok": false, "error": "task not found"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "tableDropped": false})
}

func stringValue(value any) string {
	if text, ok := value.(string); ok {
		return text
	}
	return ""
}

type storageTaskEngine struct {
	server   *Server
	mu       sync.Mutex
	timers   map[string]*time.Ticker
	stop     chan struct{}
	statsMap map[string]map[string]any
	last     map[string]float64
	edge     map[string]bool
}

func newStorageTaskEngine(server *Server) *storageTaskEngine {
	engine := &storageTaskEngine{server: server, timers: make(map[string]*time.Ticker), stop: make(chan struct{}), statsMap: make(map[string]map[string]any), last: make(map[string]float64), edge: make(map[string]bool)}
	engine.sync()
	return engine
}

func (e *storageTaskEngine) sync() {
	e.mu.Lock()
	for _, timer := range e.timers {
		timer.Stop()
	}
	e.timers = make(map[string]*time.Ticker)
	tasks := e.server.storageTasksSnapshot()
	for _, task := range tasks {
		if !boolValue(task["enabled"], true) || stringValue(task["id"]) == "" {
			continue
		}
		trigger, _ := task["trigger"].(map[string]any)
		if stringValue(trigger["mode"]) != "cycle" || e.server.storage == nil || !e.server.storage.Enabled() {
			continue
		}
		interval := intValue(trigger["intervalMs"], 1000)
		if interval < 200 {
			interval = 200
		}
		ticker := time.NewTicker(time.Duration(interval) * time.Millisecond)
		e.timers[stringValue(task["id"])] = ticker
		go e.runCycle(task, ticker)
	}
	e.mu.Unlock()
}

func (e *storageTaskEngine) runCycle(task map[string]any, ticker *time.Ticker) {
	for {
		select {
		case <-ticker.C:
			e.writeSnapshot(task)
		case <-e.stop:
			return
		}
	}
}

func (e *storageTaskEngine) onSample(sample acquisition.Sample) {
	value, ok := sampleNumber(sample)
	if !ok {
		return
	}
	for _, task := range e.server.storageTasksSnapshot() {
		if !boolValue(task["enabled"], true) {
			continue
		}
		trigger, _ := task["trigger"].(map[string]any)
		switch stringValue(trigger["mode"]) {
		case "deadband":
			if stringValue(trigger["tagId"]) != sample.TagID {
				continue
			}
			previous, exists := e.last[stringValue(task["id"])]
			e.last[stringValue(task["id"])] = value
			if exists && abs(value-previous) >= floatValue(trigger["deadband"], 0) {
				e.writeSnapshot(task)
			}
		case "edge":
			// Boolean edge triggers are handled by the bool branch below.
			_ = value
		}
	}
}

func (e *storageTaskEngine) onBoolSample(sample acquisition.Sample) {
	if sample.Value.Bool == nil {
		return
	}
	for _, task := range e.server.storageTasksSnapshot() {
		trigger, _ := task["trigger"].(map[string]any)
		if !boolValue(task["enabled"], true) || stringValue(trigger["mode"]) != "edge" || stringValue(trigger["tagId"]) != sample.TagID {
			continue
		}
		previous := e.edge[stringValue(task["id"])]
		current := *sample.Value.Bool
		e.edge[stringValue(task["id"])] = current
		direction := stringValue(trigger["edge"])
		if (direction == "rising" && !previous && current) || (direction == "falling" && previous && !current) {
			e.writeSnapshot(task)
		}
	}
}

func (e *storageTaskEngine) writeSnapshot(task map[string]any) {
	if e.server.storage == nil || !e.server.storage.Enabled() {
		return
	}
	mappings, _ := task["mappings"].([]any)
	if len(mappings) == 0 {
		return
	}
	columns := []string{"ts"}
	values := []string{"now"}
	for _, raw := range mappings {
		mapping, _ := raw.(map[string]any)
		column := sanitizeSQLName(stringValue(mapping["column"]))
		tagID := stringValue(mapping["tagId"])
		if column == "" || tagID == "" {
			continue
		}
		columns = append(columns, "`"+column+"`")
		value := e.server.engine.SnapshotValue(tagID)
		values = append(values, sqlValue(value))
	}
	if len(columns) == 1 {
		return
	}
	table := sanitizeSQLName(stringValue(task["tableName"]))
	if table == "" {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := e.server.storage.Execute(ctx, fmt.Sprintf("CREATE TABLE IF NOT EXISTS %s.%s (ts TIMESTAMP, %s)", sanitizeSQLName(e.server.storageDB()), table, strings.Join(columns[1:], " DOUBLE, ")+" DOUBLE")); err != nil {
		e.record(stringValue(task["id"]), false, err)
		return
	}
	if err := e.server.storage.Execute(ctx, fmt.Sprintf("INSERT INTO %s.%s (%s) VALUES (%s)", sanitizeSQLName(e.server.storageDB()), table, strings.Join(columns, ","), strings.Join(values, ","))); err != nil {
		e.record(stringValue(task["id"]), false, err)
		return
	}
	e.record(stringValue(task["id"]), true, nil)
}

func (s *Server) storageDB() string {
	if s.storage == nil {
		return "factory_bridge"
	}
	_, database := s.storage.ConfigSummary()
	if database == "" {
		return "factory_bridge"
	}
	return database
}

func (e *storageTaskEngine) record(id string, success bool, err error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	stat := e.statsMap[id]
	if stat == nil {
		stat = map[string]any{"writes": 0, "errors": 0, "ratePerMin": 0}
		e.statsMap[id] = stat
	}
	if success {
		stat["writes"] = intValue(stat["writes"], 0) + 1
		stat["lastWriteAt"] = time.Now().UnixMilli()
	} else {
		stat["errors"] = intValue(stat["errors"], 0) + 1
		if err != nil {
			stat["lastError"] = err.Error()
		}
	}
}

func (e *storageTaskEngine) stats() map[string]map[string]any {
	e.mu.Lock()
	defer e.mu.Unlock()
	out := make(map[string]map[string]any, len(e.statsMap))
	for id, stat := range e.statsMap {
		out[id] = cloneMap(stat)
	}
	for _, task := range e.server.storageTasksSnapshot() {
		id := stringValue(task["id"])
		if _, ok := out[id]; !ok {
			out[id] = map[string]any{"writes": 0, "errors": 0, "ratePerMin": 0}
		}
	}
	return out
}

func boolValue(value any, fallback bool) bool {
	if v, ok := value.(bool); ok {
		return v
	}
	return fallback
}
func intValue(value any, fallback int) int {
	if v, ok := value.(float64); ok {
		return int(v)
	}
	if v, ok := value.(int); ok {
		return v
	}
	return fallback
}
func floatValue(value any, fallback float64) float64 {
	if v, ok := value.(float64); ok {
		return v
	}
	return fallback
}
func sanitizeSQLName(value string) string {
	var b strings.Builder
	for _, r := range value {
		if r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '_' {
			b.WriteRune(r)
		}
	}
	return b.String()
}
func sqlValue(value any) string {
	switch v := value.(type) {
	case bool:
		if v {
			return "true"
		}
		return "false"
	case float64:
		return strconv.FormatFloat(v, 'f', -1, 64)
	case string:
		return "'" + strings.ReplaceAll(v, "'", "''") + "'"
	default:
		return "NULL"
	}
}
func sampleNumber(sample acquisition.Sample) (float64, bool) {
	if sample.Value.Number == nil {
		return 0, false
	}
	return *sample.Value.Number, true
}
