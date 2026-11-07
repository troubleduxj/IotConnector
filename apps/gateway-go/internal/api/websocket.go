package api

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/factorybridge/iotconnector/gateway-go/internal/acquisition"
	"github.com/factorybridge/iotconnector/gateway-go/internal/auth"
	"github.com/gorilla/websocket"
)

type wsClientMessage struct {
	Type  string          `json:"type"`
	TagID string          `json:"tagId,omitempty"`
	Value json.RawMessage `json:"value,omitempty"`
}

type wsTagValue struct {
	ID      string              `json:"id"`
	Value   any                 `json:"value"`
	Quality acquisition.Quality `json:"quality"`
	TS      int64               `json:"ts"`
}

type wsClient struct {
	conn       *websocket.Conn
	send       chan []byte
	mu         sync.RWMutex
	subscribed bool
	actor      string
	role       Role
}

type wsHub struct {
	mu      sync.RWMutex
	clients map[*wsClient]struct{}
	dropped atomic.Uint64 // 客户端缓冲已满而丢弃的消息数（C7），见 /metrics
}

func newWSHub() *wsHub { return &wsHub{clients: make(map[*wsClient]struct{})} }

func (h *wsHub) add(client *wsClient) {
	h.mu.Lock()
	h.clients[client] = struct{}{}
	h.mu.Unlock()
}

func (h *wsHub) remove(client *wsClient) {
	h.mu.Lock()
	if _, ok := h.clients[client]; ok {
		delete(h.clients, client)
		close(client.send)
	}
	h.mu.Unlock()
}

func (h *wsHub) broadcast(message any, subscribedOnly bool) {
	data, err := json.Marshal(message)
	if err != nil {
		return
	}
	h.mu.RLock()
	clients := make([]*wsClient, 0, len(h.clients))
	for client := range h.clients {
		client.mu.RLock()
		subscribed := client.subscribed
		client.mu.RUnlock()
		if !subscribedOnly || subscribed {
			clients = append(clients, client)
		}
	}
	h.mu.RUnlock()
	for _, client := range clients {
		select {
		case client.send <- data:
		default:
			h.dropped.Add(1)
		}
	}
}

func (s *Server) websocketHandler(w http.ResponseWriter, r *http.Request) {
	role, ok, mustChange, actor := s.authenticateWebSocket(r)
	if !ok {
		http.Error(w, "authentication required", http.StatusUnauthorized)
		return
	}
	if mustChange || !auth.RoleAtLeast(role, RoleViewer) {
		http.Error(w, "insufficient role", http.StatusForbidden)
		return
	}
	upgrader := websocket.Upgrader{
		ReadBufferSize:  4096,
		WriteBufferSize: 4096,
		// 只接受同源或白名单来源，防止跨站页面借用户浏览器的会话建立连接并写 PLC。
		CheckOrigin: s.originAllowed,
	}
	connection, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	client := &wsClient{conn: connection, send: make(chan []byte, 32), actor: actor, role: role}
	s.ws.add(client)
	defer s.ws.remove(client)
	go s.writeWebSocket(client)
	storageStatus := map[string]any{"engine": "tdengine", "state": "disabled", "queued": 0, "written": 0, "dropped": 0}
	if s.storage != nil {
		status := s.storage.Status()
		storageStatus = map[string]any{"engine": status.Engine, "state": status.State, "queued": status.Queued, "written": status.Written, "dropped": status.Dropped, "error": status.Error}
	}
	s.sendWebSocket(client, map[string]any{
		"type": "hello", "serverTime": time.Now().UnixMilli(),
		"channels": s.engine.Statuses(),
		"storage":  storageStatus,
	})

	connection.SetReadLimit(64 * 1024)
	_ = connection.SetReadDeadline(time.Now().Add(60 * time.Second))
	connection.SetPongHandler(func(string) error {
		return connection.SetReadDeadline(time.Now().Add(60 * time.Second))
	})
	for {
		_, data, err := connection.ReadMessage()
		if err != nil {
			return
		}
		_ = connection.SetReadDeadline(time.Now().Add(60 * time.Second))
		var message wsClientMessage
		if json.Unmarshal(data, &message) == nil {
			s.handleWebSocketMessage(client, message)
		}
	}
}

func (s *Server) writeWebSocket(client *wsClient) {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case data, ok := <-client.send:
			if !ok {
				return
			}
			_ = client.conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if client.conn.WriteMessage(websocket.TextMessage, data) != nil {
				return
			}
		case <-ticker.C:
			_ = client.conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if client.conn.WriteMessage(websocket.PingMessage, nil) != nil {
				return
			}
		}
	}
}

func (s *Server) handleWebSocketMessage(client *wsClient, message wsClientMessage) {
	switch message.Type {
	case "subscribe":
		client.mu.Lock()
		client.subscribed = true
		client.mu.Unlock()
		s.sendWebSocket(client, map[string]any{"type": "tags-batch", "values": wireSamples(s.engine.Snapshot())})
	case "unsubscribe":
		client.mu.Lock()
		client.subscribed = false
		client.mu.Unlock()
	case "write":
		client.mu.RLock()
		subscribed := client.subscribed
		client.mu.RUnlock()
		if !subscribed {
			s.sendWebSocket(client, map[string]any{"type": "write-result", "tagId": message.TagID, "ok": false, "error": "subscription required"})
			return
		}
		// 与 REST 写入（POST /api/tags/{id}/write）同权限：至少 operator。
		if !auth.RoleAtLeast(client.role, RoleOperator) {
			s.sendWebSocket(client, map[string]any{"type": "write-result", "tagId": message.TagID, "ok": false, "error": "insufficient role"})
			return
		}
		value, err := decodeWriteValue(message.Value)
		if err == nil {
			writeCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			err = s.engine.Write(writeCtx, message.TagID, value)
			cancel()
			s.recordWriteBy(client.actor, message.TagID, value, err)
		}
		result := map[string]any{"type": "write-result", "tagId": message.TagID, "ok": err == nil}
		if err != nil {
			result["error"] = err.Error()
		}
		s.sendWebSocket(client, result)
	}
}

func (s *Server) sendWebSocket(client *wsClient, message any) {
	data, err := json.Marshal(message)
	if err != nil {
		return
	}
	select {
	case client.send <- data:
	default:
	}
}

func (s *Server) BroadcastStorageStatus() {
	status := map[string]any{"engine": "tdengine", "state": "disabled", "queued": 0, "written": 0, "dropped": 0}
	if s.storage != nil {
		value := s.storage.Status()
		status = map[string]any{"engine": value.Engine, "state": value.State, "queued": value.Queued, "written": value.Written, "dropped": value.Dropped, "error": value.Error}
	}
	s.ws.broadcast(map[string]any{"type": "storage-status", "status": status}, true)
}

// authenticateWebSocket 校验握手。依次接受：Authorization 头（脚本客户端）、
// ?ticket= 一次性票据（控制台，见 wsticket.go）、?token= 会话令牌（已弃用，兼容旧客户端）。
func (s *Server) authenticateWebSocket(r *http.Request) (Role, bool, bool, string) {
	if s.devNoAuth {
		return devPrincipal.Role, true, false, devPrincipal.Username
	}
	if ticket := strings.TrimSpace(r.URL.Query().Get("ticket")); ticket != "" {
		p, ok := s.wsTickets.redeem(ticket)
		if !ok {
			return "", false, false, ""
		}
		return p.Role, true, p.MustChangePassword, p.Username
	}
	token := bearerToken(r)
	if token == "" {
		token = strings.TrimSpace(r.URL.Query().Get("token"))
		if token != "" {
			s.warnQueryTokenOnce()
		}
	}
	p, ok := s.authenticateToken(r.Context(), token)
	if !ok {
		return "", false, false, ""
	}
	return p.Role, true, p.MustChangePassword, p.Username
}

func wireSamples(samples []acquisition.Sample) []wsTagValue {
	values := make([]wsTagValue, 0, len(samples))
	for _, sample := range samples {
		values = append(values, wsTagValue{ID: sample.TagID, Value: wireValue(sample.Value), Quality: sample.Quality, TS: sample.SampledAt})
	}
	return values
}

func wireValue(value acquisition.Value) any {
	if value.Number != nil {
		return *value.Number
	}
	if value.String != nil {
		return *value.String
	}
	if value.Bool != nil {
		return *value.Bool
	}
	return nil
}

var queryTokenWarned sync.Once

func (s *Server) warnQueryTokenOnce() {
	queryTokenWarned.Do(func() {
		log.Printf("websocket: client authenticated with ?token= (deprecated; tokens in URLs end up in proxy logs). Use POST /api/auth/ws-ticket and ?ticket= instead")
	})
}
