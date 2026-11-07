package api

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"net/url"
	"testing"
	"time"

	"github.com/factorybridge/iotconnector/gateway-go/internal/acquisition"
	"github.com/factorybridge/iotconnector/gateway-go/internal/config"
	"github.com/gorilla/websocket"
)

type websocketTestDriver struct{}

func (websocketTestDriver) Start(context.Context) error { return nil }
func (websocketTestDriver) Stop(context.Context) error  { return nil }
func (websocketTestDriver) Read(context.Context, []acquisition.Tag) ([]acquisition.Sample, error) {
	return nil, nil
}
func (websocketTestDriver) Test(context.Context, []acquisition.Tag) error { return nil }
func (websocketTestDriver) Write(context.Context, acquisition.Tag, acquisition.Value) error {
	return nil
}

func TestWebSocketRequiresAuthAndBroadcastsCompatibleMessages(t *testing.T) {
	engine := acquisition.NewEngine(
		[]acquisition.Channel{{ID: "ch-1", Enabled: true}},
		[]acquisition.Tag{{ID: "tag-1", ChannelID: "ch-1"}},
		func(acquisition.Channel, []acquisition.Tag, func(acquisition.Sample), func(acquisition.ChannelStatus)) acquisition.Driver {
			return websocketTestDriver{}
		},
	)
	if err := engine.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	defer engine.Stop(context.Background())
	server := NewServerWithOptions(config.Config{}, engine, SecurityOptions{ViewerToken: "viewer-token", OperatorToken: "operator-token"})
	httpServer := httptest.NewServer(server.Handler())
	defer httpServer.Close()
	wsURL := "ws" + httpServer.URL[len("http"):]

	if _, _, err := websocket.DefaultDialer.Dial(wsURL+"/ws", nil); err == nil {
		t.Fatal("unauthenticated websocket handshake unexpectedly succeeded")
	}

	header := make(map[string][]string)
	header["Authorization"] = []string{"Bearer operator-token"}
	connection, _, err := websocket.DefaultDialer.Dial(wsURL+"/ws", header)
	if err != nil {
		t.Fatal(err)
	}
	defer connection.Close()
	_ = connection.SetReadDeadline(time.Now().Add(2 * time.Second))

	var hello map[string]any
	if err := connection.ReadJSON(&hello); err != nil {
		t.Fatal(err)
	}
	if hello["type"] != "hello" {
		t.Fatalf("unexpected hello: %#v", hello)
	}
	if err := connection.WriteJSON(map[string]any{"type": "subscribe"}); err != nil {
		t.Fatal(err)
	}
	var snapshot map[string]any
	if err := connection.ReadJSON(&snapshot); err != nil {
		t.Fatal(err)
	}
	if snapshot["type"] != "tags-batch" {
		t.Fatalf("unexpected snapshot: %#v", snapshot)
	}

	if err := connection.WriteJSON(map[string]any{"type": "write", "tagId": "tag-1", "value": 7}); err != nil {
		t.Fatal(err)
	}
	// C7 之后实时样本每 100ms 合并推送，写值回执可能先于样本批次到达，两者都要收到，顺序不限。
	var gotUpdate, gotResult bool
	for !(gotUpdate && gotResult) {
		var message map[string]any
		if err := connection.ReadJSON(&message); err != nil {
			t.Fatalf("waiting for update=%v result=%v: %v", gotUpdate, gotResult, err)
		}
		switch message["type"] {
		case "tags-batch":
			gotUpdate = true
		case "write-result":
			if message["ok"] != true {
				t.Fatalf("unexpected write result: %#v", message)
			}
			gotResult = true
		}
	}

	// Confirm query-token compatibility for browser clients.
	queryURL, err := url.Parse(wsURL + "/ws?token=viewer-token")
	if err != nil {
		t.Fatal(err)
	}
	queryConnection, _, err := websocket.DefaultDialer.Dial(queryURL.String(), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer queryConnection.Close()
	var queryHello map[string]any
	if err := queryConnection.ReadJSON(&queryHello); err != nil {
		t.Fatal(err)
	}
	if queryHello["type"] != "hello" {
		t.Fatalf("unexpected query-token hello: %s", mustJSON(queryHello))
	}

	// 回归 B1：viewer 已订阅也不能经 WebSocket 写 PLC。
	if err := queryConnection.WriteJSON(map[string]any{"type": "subscribe"}); err != nil {
		t.Fatal(err)
	}
	_ = queryConnection.SetReadDeadline(time.Now().Add(2 * time.Second))
	var viewerSnapshot map[string]any
	if err := queryConnection.ReadJSON(&viewerSnapshot); err != nil {
		t.Fatal(err)
	}
	if err := queryConnection.WriteJSON(map[string]any{"type": "write", "tagId": "tag-1", "value": 9}); err != nil {
		t.Fatal(err)
	}
	for {
		var message map[string]any
		if err := queryConnection.ReadJSON(&message); err != nil {
			t.Fatal(err)
		}
		if message["type"] != "write-result" {
			continue // 跳过实时批次等广播
		}
		if message["ok"] != false || message["error"] != "insufficient role" {
			t.Fatalf("viewer websocket write was not rejected: %s", mustJSON(message))
		}
		break
	}
}

func mustJSON(value any) string {
	data, _ := json.Marshal(value)
	return string(data)
}
