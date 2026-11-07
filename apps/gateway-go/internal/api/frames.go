package api

import (
	"net/http"
	"strconv"

	"github.com/factorybridge/iotconnector/gateway-go/internal/acquisition"
)

// channelFrames 返回通道最近的收发报文（FR-M2-20）。?limit=1..200（默认 100），?dir=TX|RX，?clear=1 先清空。
// 报文可能含设备数据，要求 operator；清空属于写操作，同样要求 operator（路由级已校验）。
func (s *Server) channelFrames(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("channelID")
	q := r.URL.Query()
	if q.Get("clear") == "1" {
		acquisition.ClearFrames(id)
	}
	limit := 100
	if value, err := strconv.Atoi(q.Get("limit")); err == nil && value > 0 {
		limit = min(value, 200)
	}
	dir := q.Get("dir")
	if dir != "TX" && dir != "RX" {
		dir = ""
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "frames": acquisition.Frames(id, limit, dir)})
}

func notImplemented(w http.ResponseWriter) {
	writeJSON(w, http.StatusNotImplemented, map[string]any{"ok": false, "error": "not implemented"})
}
