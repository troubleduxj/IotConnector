package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/factorybridge/iotconnector/gateway-go/internal/acquisition"
	"github.com/factorybridge/iotconnector/gateway-go/internal/config"
	"github.com/gorilla/websocket"
)

func ticketFor(t *testing.T, h http.Handler, token string) string {
	t.Helper()
	r := call(h, "POST", "/api/auth/ws-ticket", token, "")
	var body struct {
		Ticket string `json:"ticket"`
	}
	if r.Code != http.StatusOK || json.Unmarshal(r.Body.Bytes(), &body) != nil || body.Ticket == "" {
		t.Fatalf("ws-ticket: %d %s", r.Code, r.Body.String())
	}
	return body.Ticket
}

// B9：票据只能用一次、过期作废、不需要把会话令牌放进 URL。
func TestWSTicketIsSingleUse(t *testing.T) {
	server := NewServerWithOptions(config.Config{}, acquisition.NewEngine(nil, nil, nil), SecurityOptions{OperatorToken: "op"})
	httpServer := httptest.NewServer(server.Handler())
	defer httpServer.Close()
	wsURL := "ws" + strings.TrimPrefix(httpServer.URL, "http") + "/ws?ticket="

	ticket := ticketFor(t, server.Handler(), "op")
	conn, _, err := websocket.DefaultDialer.Dial(wsURL+ticket, nil)
	if err != nil {
		t.Fatalf("first use rejected: %v", err)
	}
	conn.Close()
	if c, _, err := websocket.DefaultDialer.Dial(wsURL+ticket, nil); err == nil {
		c.Close()
		t.Fatal("ticket accepted twice")
	}
	if c, _, err := websocket.DefaultDialer.Dial(wsURL+"forged", nil); err == nil {
		c.Close()
		t.Fatal("forged ticket accepted")
	}
}

func TestWSTicketExpires(t *testing.T) {
	store := newWSTicketStore()
	ticket := store.issue(devPrincipal)
	store.mu.Lock()
	entry := store.tickets[ticket]
	entry.expires = time.Now().Add(-time.Second)
	store.tickets[ticket] = entry
	store.mu.Unlock()
	if _, ok := store.redeem(ticket); ok {
		t.Fatal("expired ticket redeemed")
	}
}

// 票据携带签发者的角色：viewer 的票据建立的连接仍不能写值（B1 不因 B9 回退）。
func TestWSTicketKeepsRole(t *testing.T) {
	server := NewServerWithOptions(config.Config{}, acquisition.NewEngine(nil, nil, nil), SecurityOptions{ViewerToken: "v"})
	httpServer := httptest.NewServer(server.Handler())
	defer httpServer.Close()
	ticket := ticketFor(t, server.Handler(), "v")
	conn, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(httpServer.URL, "http")+"/ws?ticket="+ticket, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	_ = conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	var hello map[string]any
	_ = conn.ReadJSON(&hello)
	_ = conn.WriteJSON(map[string]any{"type": "subscribe"})
	_ = conn.WriteJSON(map[string]any{"type": "write", "tagId": "t1", "value": 1})
	for {
		var msg map[string]any
		if err := conn.ReadJSON(&msg); err != nil {
			t.Fatal(err)
		}
		if msg["type"] == "write-result" {
			if msg["ok"] != false || msg["error"] != "insufficient role" {
				t.Fatalf("viewer via ticket wrote: %v", msg)
			}
			return
		}
	}
}

func TestWSTicketRequiresAuth(t *testing.T) {
	server := NewServerWithOptions(config.Config{}, acquisition.NewEngine(nil, nil, nil), SecurityOptions{ViewerToken: "v"})
	if r := call(server.Handler(), "POST", "/api/auth/ws-ticket", "", ""); r.Code != http.StatusUnauthorized {
		t.Fatalf("anonymous ticket: %d", r.Code)
	}
}
