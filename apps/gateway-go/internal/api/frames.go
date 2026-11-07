package api

import "net/http"

// 报文抓包。由主会话实现。

func (s *Server) channelFrames(w http.ResponseWriter, r *http.Request) { notImplemented(w) }

func notImplemented(w http.ResponseWriter) {
	writeJSON(w, http.StatusNotImplemented, map[string]any{"ok": false, "error": "not implemented"})
}
