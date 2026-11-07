package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"reflect"
	"strings"
	"sync"
	"time"

	"github.com/dop251/goja"
	"github.com/factorybridge/iotconnector/gateway-go/internal/acquisition"
	"github.com/factorybridge/iotconnector/gateway-go/internal/scriptworker"
)

type scriptTrigger struct {
	Type       string `json:"type"`
	IntervalMs int    `json:"intervalMs,omitempty"`
	TagID      string `json:"tagId,omitempty"`
}
type gatewayScript struct {
	ID          string        `json:"id"`
	Name        string        `json:"name"`
	Description string        `json:"description"`
	Code        string        `json:"code"`
	Trigger     scriptTrigger `json:"trigger"`
	Enabled     bool          `json:"enabled"`
}
type scriptStat struct {
	Runs              int    `json:"runs"`
	LastRunAt         int64  `json:"lastRunAt,omitempty"`
	LastDurationMs    int64  `json:"lastDurationMs,omitempty"`
	Errors            int    `json:"errors"`
	LastError         string `json:"lastError,omitempty"`
	ConsecutiveErrors int    `json:"consecutiveErrors"`
	AutoDisabled      bool   `json:"autoDisabled,omitempty"`
}

const maxScriptCodeBytes = 64 * 1024

type scriptEngine struct {
	server  *Server
	mu      sync.Mutex
	outputs map[string][]string
	stats   map[string]scriptStat
	timers  map[string]chan struct{}
	last    map[string]any
}

func newScriptEngine(server *Server) *scriptEngine {
	return &scriptEngine{server: server, outputs: map[string][]string{}, stats: map[string]scriptStat{}, timers: map[string]chan struct{}{}, last: map[string]any{}}
}

func (e *scriptEngine) configure() {
	e.mu.Lock()
	defer e.mu.Unlock()
	wanted := map[string]gatewayScript{}
	for _, script := range e.scripts() {
		wanted[script.ID] = script
	}
	for id, stop := range e.timers {
		if script, ok := wanted[id]; !ok || !script.Enabled || script.Trigger.Type != "interval" {
			close(stop)
			delete(e.timers, id)
		}
	}
	for id, script := range wanted {
		if !script.Enabled || script.Trigger.Type != "interval" || script.Trigger.IntervalMs <= 0 {
			continue
		}
		if _, exists := e.timers[id]; exists {
			continue
		}
		stop := make(chan struct{})
		e.timers[id] = stop
		interval := time.Duration(script.Trigger.IntervalMs) * time.Millisecond
		if interval < 500*time.Millisecond {
			interval = 500 * time.Millisecond
		}
		go func(scriptID string, stop <-chan struct{}, interval time.Duration) {
			ticker := time.NewTicker(interval)
			defer ticker.Stop()
			for {
				select {
				case <-ticker.C:
					_, _ = e.run(scriptID)
				case <-stop:
					return
				}
			}
		}(id, stop, interval)
	}
}

func (e *scriptEngine) stop() {
	e.mu.Lock()
	for id, stop := range e.timers {
		close(stop)
		delete(e.timers, id)
	}
	e.mu.Unlock()
}

func (e *scriptEngine) onSample(sample acquisition.Sample) {
	value := wireValue(sample.Value)
	e.mu.Lock()
	previous, hadPrevious := e.last[sample.TagID]
	e.last[sample.TagID] = value
	e.mu.Unlock()
	if hadPrevious && reflect.DeepEqual(previous, value) {
		return
	}
	for _, script := range e.scripts() {
		if script.Enabled && script.Trigger.Type == "tagChange" && script.Trigger.TagID == sample.TagID {
			go func(id string) { _, _ = e.run(id) }(script.ID)
		}
	}
}

func (e *scriptEngine) scripts() []gatewayScript {
	items, ok := e.server.cfg().Raw["scripts"].([]any)
	if !ok {
		return []gatewayScript{}
	}
	b, _ := json.Marshal(items)
	var out []gatewayScript
	_ = json.Unmarshal(b, &out)
	return out
}
func (e *scriptEngine) save(items []gatewayScript) error {
	b, err := json.Marshal(items)
	if err != nil {
		return err
	}
	var raw []any
	if err = json.Unmarshal(b, &raw); err != nil {
		return err
	}
	return e.server.commitRawLocked("scripts", raw)
}

func (e *scriptEngine) list() []map[string]any {
	out := make([]map[string]any, 0)
	for _, script := range e.scripts() {
		item := map[string]any{"id": script.ID, "name": script.Name, "description": script.Description, "code": script.Code, "trigger": script.Trigger, "enabled": script.Enabled, "output": e.getOutput(script.ID), "stats": e.getStat(script.ID)}
		out = append(out, item)
	}
	return out
}
func (e *scriptEngine) getOutput(id string) []string {
	e.mu.Lock()
	defer e.mu.Unlock()
	return append([]string(nil), e.outputs[id]...)
}
func (e *scriptEngine) getStat(id string) scriptStat {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.stats[id]
}

func (e *scriptEngine) run(id string) (map[string]any, error) {
	var script *gatewayScript
	for _, item := range e.scripts() {
		if item.ID == id {
			copy := item
			script = &copy
			break
		}
	}
	if script == nil {
		return nil, fmt.Errorf("script not found")
	}
	if os.Getenv("GATEWAY_GO_SCRIPT_INLINE") != "1" {
		return e.runIsolated(id, *script)
	}
	stat := e.getStat(id)
	if stat.AutoDisabled {
		return map[string]any{"ok": false, "outputs": e.getOutput(id), "error": "script auto-disabled after consecutive failures", "durationMs": 0}, nil
	}
	outputs := []string{}
	writes := []struct {
		tagID string
		value acquisition.Value
	}{}
	runtime := goja.New()
	start := time.Now()
	lookup := func(key string) (any, error) {
		for _, tag := range e.server.cfg().Tags {
			if tag.ID == key || tag.Name == key {
				if sample, ok := e.server.engine.SnapshotByID(tag.ID); ok {
					return wireValue(sample.Value), nil
				}
				return nil, fmt.Errorf("Read: tag has no value")
			}
		}
		return nil, fmt.Errorf("Read: tag not found")
	}
	runtime.Set("Read", func(key string) any {
		value, err := lookup(key)
		if err != nil {
			panic(runtime.ToValue(err.Error()))
		}
		return value
	})
	runtime.Set("Write", func(key string, value any) {
		for _, tag := range e.server.cfg().Tags {
			if tag.ID == key || tag.Name == key {
				writes = append(writes, struct {
					tagID string
					value acquisition.Value
				}{tag.ID, decodeAnyValue(value)})
				outputs = append(outputs, fmt.Sprintf("Write %s = %v", key, value))
				return
			}
		}
		panic(runtime.ToValue("Write: tag not found"))
	})
	runtime.Set("log", func(args ...any) {
		if len(outputs) >= 50 {
			return
		}
		parts := make([]string, len(args))
		for i, arg := range args {
			parts[i] = fmt.Sprint(arg)
		}
		outputs = append(outputs, strings.Join(parts, " "))
	})
	runtime.Set("console", map[string]any{"log": func(args ...any) {
		if len(outputs) < 50 {
			parts := make([]string, len(args))
			for i, arg := range args {
				parts[i] = fmt.Sprint(arg)
			}
			outputs = append(outputs, strings.Join(parts, " "))
		}
	}})
	timer := time.AfterFunc(time.Second, func() { runtime.Interrupt("script timeout") })
	_, execErr := runtime.RunString(script.Code)
	timer.Stop()
	if execErr == nil {
		for _, write := range writes {
			if err := e.server.engine.Write(context.Background(), write.tagID, write.value); err != nil {
				outputs = append(outputs, "Write failed: "+err.Error())
			}
		}
	}
	duration := time.Since(start).Milliseconds()
	e.mu.Lock()
	e.outputs[id] = append(append(e.outputs[id], outputs...), nil...)
	if len(e.outputs[id]) > 50 {
		e.outputs[id] = e.outputs[id][len(e.outputs[id])-50:]
	}
	stat.Runs++
	stat.LastRunAt = time.Now().UnixMilli()
	stat.LastDurationMs = duration
	if execErr != nil {
		stat.Errors++
		stat.ConsecutiveErrors++
		stat.LastError = execErr.Error()
		if stat.ConsecutiveErrors >= 3 && script.Enabled {
			stat.AutoDisabled = true
		}
	} else {
		stat.ConsecutiveErrors = 0
	}
	e.stats[id] = stat
	e.mu.Unlock()
	if execErr != nil && stat.AutoDisabled {
		script.Enabled = false
		items := e.scripts()
		for i := range items {
			if items[i].ID == id {
				items[i].Enabled = false
			}
		}
		e.server.configMu.Lock()
		_ = e.save(items)
		e.server.configMu.Unlock()
	}
	result := map[string]any{"ok": execErr == nil, "outputs": e.getOutput(id), "durationMs": duration}
	if execErr != nil {
		result["error"] = execErr.Error()
	}
	return result, nil
}

func (e *scriptEngine) runIsolated(id string, script gatewayScript) (map[string]any, error) {
	values := map[string]any{}
	tags := map[string]string{}
	for _, tag := range e.server.cfg().Tags {
		tags[tag.ID], tags[tag.Name] = tag.ID, tag.ID
		if sample, ok := e.server.engine.SnapshotByID(tag.ID); ok {
			values[tag.ID], values[tag.Name] = wireValue(sample.Value), wireValue(sample.Value)
		}
	}
	request, err := json.Marshal(scriptworker.Request{Code: script.Code, Values: values, Tags: tags})
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 1500*time.Millisecond)
	defer cancel()
	executable, err := os.Executable()
	if err != nil {
		return nil, err
	}
	command := exec.CommandContext(ctx, executable)
	command.Env = append(os.Environ(), "GATEWAY_GO_SCRIPT_WORKER=1")
	command.Stdin = strings.NewReader(string(request))
	output, err := command.Output()
	duration := time.Now()
	var response scriptworker.Response
	if decodeErr := json.Unmarshal(output, &response); decodeErr != nil {
		if err != nil {
			response.Error = err.Error()
		} else {
			response.Error = decodeErr.Error()
		}
		response.OK = false
	}
	for _, write := range response.Writes {
		if writeErr := e.server.engine.Write(context.Background(), write.TagID, decodeAnyValue(write.Value)); writeErr != nil {
			response.Outputs = append(response.Outputs, "Write failed: "+writeErr.Error())
		}
	}
	if response.DurationMs == 0 {
		response.DurationMs = time.Since(duration).Milliseconds()
	}
	e.mu.Lock()
	e.outputs[id] = append(e.outputs[id], response.Outputs...)
	if len(e.outputs[id]) > 50 {
		e.outputs[id] = e.outputs[id][len(e.outputs[id])-50:]
	}
	stat := e.stats[id]
	stat.Runs++
	stat.LastRunAt = time.Now().UnixMilli()
	stat.LastDurationMs = response.DurationMs
	if !response.OK {
		stat.Errors++
		stat.ConsecutiveErrors++
		stat.LastError = response.Error
		if stat.ConsecutiveErrors >= 3 && script.Enabled {
			stat.AutoDisabled = true
		}
	} else {
		stat.ConsecutiveErrors = 0
	}
	e.stats[id] = stat
	e.mu.Unlock()
	if response.OK == false && e.getStat(id).AutoDisabled {
		items := e.scripts()
		for i := range items {
			if items[i].ID == id {
				items[i].Enabled = false
			}
		}
		e.server.configMu.Lock()
		_ = e.save(items)
		e.server.configMu.Unlock()
		e.configure()
	}
	result := map[string]any{"ok": response.OK, "outputs": e.getOutput(id), "durationMs": response.DurationMs}
	if !response.OK {
		result["error"] = response.Error
	}
	return result, nil
}

func (s *Server) scriptsAPI(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, 200, s.scriptEngine.list())
}
func (s *Server) createScript(w http.ResponseWriter, r *http.Request) {
	var script gatewayScript
	if json.NewDecoder(r.Body).Decode(&script) != nil || strings.TrimSpace(script.Name) == "" || strings.TrimSpace(script.Code) == "" {
		writeJSON(w, 400, map[string]any{"ok": false, "error": "name & code required"})
		return
	}
	if len([]byte(script.Code)) > maxScriptCodeBytes {
		writeJSON(w, 413, map[string]any{"ok": false, "error": "script code exceeds 64 KiB"})
		return
	}
	script.ID = fmt.Sprintf("scr_%d", time.Now().UnixMilli())
	if script.Trigger.Type == "" {
		script.Trigger.Type = "manual"
	}
	s.configMu.Lock()
	items := s.scriptEngine.scripts()
	items = append(items, script)
	err := s.scriptEngine.save(items)
	s.configMu.Unlock()
	if err != nil {
		writeJSON(w, 500, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	s.scriptEngine.configure()
	writeJSON(w, 201, script)
}
func (s *Server) updateScript(w http.ResponseWriter, r *http.Request) {
	var patch map[string]any
	if json.NewDecoder(r.Body).Decode(&patch) != nil {
		writeJSON(w, 400, map[string]any{"ok": false, "error": "invalid script JSON"})
		return
	}
	s.configMu.Lock()
	items := s.scriptEngine.scripts()
	for i := range items {
		if items[i].ID == r.PathValue("scriptID") {
			b, _ := json.Marshal(patch)
			var p gatewayScript
			_ = json.Unmarshal(b, &p)
			if p.Name != "" {
				items[i].Name = p.Name
			}
			if p.Description != "" {
				items[i].Description = p.Description
			}
			if p.Code != "" {
				if len([]byte(p.Code)) > maxScriptCodeBytes {
					s.configMu.Unlock()
					writeJSON(w, 413, map[string]any{"ok": false, "error": "script code exceeds 64 KiB"})
					return
				}
				items[i].Code = p.Code
			}
			if p.Trigger.Type != "" {
				items[i].Trigger = p.Trigger
			}
			if value, ok := patch["enabled"].(bool); ok {
				items[i].Enabled = value
			}
			err := s.scriptEngine.save(items)
			s.configMu.Unlock()
			if err != nil {
				writeJSON(w, 500, map[string]any{"ok": false, "error": err.Error()})
				return
			}
			s.scriptEngine.configure()
			writeJSON(w, 200, items[i])
			return
		}
	}
	s.configMu.Unlock()
	writeJSON(w, 404, map[string]any{"ok": false, "error": "script not found"})
}
func (s *Server) deleteScript(w http.ResponseWriter, r *http.Request) {
	s.configMu.Lock()
	old := s.scriptEngine.scripts()
	next := make([]gatewayScript, 0, len(old))
	for _, item := range old {
		if item.ID != r.PathValue("scriptID") {
			next = append(next, item)
		}
	}
	if len(next) == len(old) {
		s.configMu.Unlock()
		writeJSON(w, 404, map[string]any{"ok": false, "error": "script not found"})
		return
	}
	err := s.scriptEngine.save(next)
	s.configMu.Unlock()
	if err != nil {
		writeJSON(w, 500, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	s.scriptEngine.configure()
	writeJSON(w, 200, map[string]any{"ok": true})
}
func (s *Server) runScript(w http.ResponseWriter, r *http.Request) {
	result, err := s.scriptEngine.run(r.PathValue("scriptID"))
	if err != nil {
		writeJSON(w, 404, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	writeJSON(w, 200, result)
}
func (s *Server) scriptOutput(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, 200, map[string]any{"output": s.scriptEngine.getOutput(r.PathValue("scriptID"))})
}
