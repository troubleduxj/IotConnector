package api

import (
	"encoding/json"
	"net/http"
)

func (s *Server) shadow(w http.ResponseWriter, r *http.Request) {
	if !s.authorize(w, r, RoleViewer) {
		return
	}
	shadows := s.shadowSnapshot()
	writeJSON(w, http.StatusOK, map[string]any{"shadows": shadows, "pending": s.shadowStore.PendingCount()})
}

func (s *Server) northbound(w http.ResponseWriter, r *http.Request) {
	if !s.authorize(w, r, RoleViewer) {
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"config": s.northboundConfig(), "status": s.northboundStatus()})
}

func (s *Server) updateNorthbound(w http.ResponseWriter, r *http.Request) {
	if !s.authorize(w, r, RoleAdmin) {
		return
	}
	var patch map[string]any
	if err := json.NewDecoder(r.Body).Decode(&patch); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": "invalid northbound JSON"})
		return
	}
	s.configMu.Lock()
	cfg := s.northboundConfig()
	mergeMap(cfg, patch)
	s.config.Raw["northbound"] = cfg
	err := error(nil)
	if s.configStore != nil {
		err = s.configStore.Save(s.config)
	}
	s.configMu.Unlock()
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"config": cfg, "status": s.northboundStatus()})
}

func (s *Server) rebirthNorthbound(w http.ResponseWriter, r *http.Request) {
	if !s.authorize(w, r, RoleAdmin) {
		return
	}
	if s.northboundPublisher != nil {
		s.northboundPublisher.Rebirth()
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "status": s.northboundStatus()})
}

func (s *Server) northboundConfig() map[string]any {
	if cfg, ok := s.config.Raw["northbound"].(map[string]any); ok {
		return cloneMap(cfg)
	}
	return map[string]any{"enabled": false, "url": "mqtt://127.0.0.1:1883", "groupId": "Factory", "edgeNodeId": "FB_Edge_GW01", "dataFlushMs": 1000}
}

func (s *Server) northboundStatus() map[string]any {
	cfg := s.northboundConfig()
	enabled, _ := cfg["enabled"].(bool)
	if s.northboundPublisher != nil {
		status := s.northboundPublisher.Status()
		return map[string]any{"connected": status.Connected, "enabled": enabled, "bdSeq": status.BDSeq, "seq": status.Seq, "queued": status.Queued, "dropped": status.Dropped, "published": status.Published, "lastPublishAt": status.LastPublishAt, "lastError": status.LastError}
	}
	return map[string]any{"connected": false, "enabled": enabled, "bdSeq": 0, "seq": 0, "queued": 0, "dropped": 0, "published": 0, "lastError": "MQTT publisher not enabled in Go runtime"}
}
