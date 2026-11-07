package api

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/factorybridge/iotconnector/gateway-go/internal/acquisition"
)

// C7：100ms 内的样本合并为一条消息，同一位号只保留最新值，顺序按首次出现。
func TestSampleBatcherCoalesces(t *testing.T) {
	hub := newWSHub()
	client := &wsClient{send: make(chan []byte, 8), subscribed: true}
	hub.add(client)
	b := newSampleBatcher(hub)
	for i := 0; i < 50; i++ {
		b.add(acquisition.Sample{TagID: "a", Value: acquisition.NumberValue(float64(i))})
		b.add(acquisition.Sample{TagID: "b", Value: acquisition.NumberValue(float64(-i))})
	}
	select {
	case data := <-client.send:
		var msg struct {
			Type   string       `json:"type"`
			Values []wsTagValue `json:"values"`
		}
		if err := json.Unmarshal(data, &msg); err != nil {
			t.Fatal(err)
		}
		if msg.Type != "tags-batch" || len(msg.Values) != 2 || msg.Values[0].ID != "a" || msg.Values[0].Value != 49.0 || msg.Values[1].Value != -49.0 {
			t.Fatalf("batch = %s", data)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("no batch flushed")
	}
	select {
	case extra := <-client.send:
		t.Fatalf("100 samples produced more than one message: %s", extra)
	case <-time.After(3 * liveBatchInterval):
	}
	b.stop()
	b.add(acquisition.Sample{TagID: "c"})
	select {
	case <-client.send:
		t.Fatal("batcher sent after stop")
	case <-time.After(3 * liveBatchInterval):
	}
}

func TestHubCountsDroppedMessages(t *testing.T) {
	hub := newWSHub()
	client := &wsClient{send: make(chan []byte, 1), subscribed: true}
	hub.add(client)
	for i := 0; i < 5; i++ {
		hub.broadcast(map[string]any{"type": "x"}, true)
	}
	if got := hub.dropped.Load(); got != 4 {
		t.Fatalf("dropped = %d, want 4", got)
	}
}
