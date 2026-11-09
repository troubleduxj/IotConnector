package northbound

import (
	"net"
	"testing"
	"time"

	"github.com/factorybridge/iotconnector/gateway-go/internal/acquisition"
)

func TestConfigFromRawDefaults(t *testing.T) {
	got := ConfigFromRaw(nil)
	want := Config{URL: "mqtt://127.0.0.1:1883", GroupID: "Factory", EdgeNodeID: "FB_Edge_GW01", DataFlushMs: 1000}
	if got != want {
		t.Fatalf("defaults = %+v, want %+v", got, want)
	}
	got = ConfigFromRaw(map[string]any{"enabled": true, "url": "mqtt://broker:1883", "groupId": "G", "dataFlushMs": float64(250)})
	if !got.Enabled || got.URL != "mqtt://broker:1883" || got.GroupID != "G" || got.DataFlushMs != 250 || got.EdgeNodeID != "FB_Edge_GW01" {
		t.Fatalf("parsed = %+v", got)
	}
}

// acceptCounter 是一个只计数连接的 TCP 监听，用来观察发布器是否（重新）连接。
func acceptCounter(t *testing.T) (string, <-chan struct{}) {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { listener.Close() })
	accepted := make(chan struct{}, 16)
	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			accepted <- struct{}{}
			go func() { time.Sleep(200 * time.Millisecond); conn.Close() }()
		}
	}()
	return "mqtt://" + listener.Addr().String(), accepted
}

func waitAccept(t *testing.T, accepted <-chan struct{}, want bool) {
	t.Helper()
	select {
	case <-accepted:
		if !want {
			t.Fatal("unexpected connection attempt")
		}
	case <-time.After(3 * time.Second):
		if want {
			t.Fatal("publisher did not connect to the new broker")
		}
	}
}

func TestReconfigureReconnectsToNewBroker(t *testing.T) {
	oldURL, oldAccepted := acceptCounter(t)
	newURL, newAccepted := acceptCounter(t)
	p := New(Config{Enabled: true, URL: oldURL, GroupID: "G", EdgeNodeID: "N"}, "", nil, nil)
	p.Start()
	t.Cleanup(p.Stop)
	waitAccept(t, oldAccepted, true)

	if !p.Reconfigure(Config{Enabled: true, URL: newURL, GroupID: "G", EdgeNodeID: "N"}) {
		t.Fatal("URL change should reconnect")
	}
	waitAccept(t, newAccepted, true)
	if p.current().cfg.URL != newURL {
		t.Fatalf("config not replaced: %+v", p.current().cfg)
	}
}

func TestReconfigureFlushIntervalDoesNotReconnect(t *testing.T) {
	p := New(Config{Enabled: false, URL: "mqtt://127.0.0.1:1", GroupID: "G", EdgeNodeID: "N", DataFlushMs: 1000}, "", nil, nil)
	if p.Reconfigure(Config{Enabled: false, URL: "mqtt://127.0.0.1:1", GroupID: "G", EdgeNodeID: "N", DataFlushMs: 200}) {
		t.Fatal("flush interval change must not reconnect")
	}
	if p.current().cfg.DataFlushMs != 200 {
		t.Fatal("flush interval not applied")
	}
	if p.Reconfigure(Config{Enabled: false, URL: "mqtt://127.0.0.1:1", GroupID: "G", EdgeNodeID: "N", DataFlushMs: 200}) {
		t.Fatal("identical config must be a no-op")
	}
}

func TestReconfigureDisableStopsPublisher(t *testing.T) {
	url, accepted := acceptCounter(t)
	p := New(Config{Enabled: true, URL: url, GroupID: "G", EdgeNodeID: "N"}, "", nil, nil)
	p.Start()
	t.Cleanup(p.Stop)
	waitAccept(t, accepted, true)
	if !p.Reconfigure(Config{Enabled: false, URL: url, GroupID: "G", EdgeNodeID: "N"}) {
		t.Fatal("disabling should count as a reconnect change")
	}
	p.mu.Lock()
	client := p.client
	p.mu.Unlock()
	if client != nil {
		t.Fatal("disabled publisher still holds a client")
	}
	// 关闭瞬间可能还有一次已发出的连接尝试，先放过 1 秒；
	// 之后不得再有重试（paho 的重试间隔是 5 秒，这里等 6 秒确认）。
	settle := time.After(time.Second)
	for settling := true; settling; {
		select {
		case <-accepted:
		case <-settle:
			settling = false
		}
	}
	drain := time.After(6 * time.Second)
	for {
		select {
		case <-accepted:
			t.Fatal("disabled publisher kept reconnecting")
		case <-drain:
			return
		}
	}
}

func TestSetModelUpdatesTagLookup(t *testing.T) {
	p := New(Config{}, "", nil, []acquisition.Tag{{ID: "t1", Name: "Old"}})
	if _, ok := p.TagByName("New"); ok {
		t.Fatal("unexpected tag")
	}
	p.SetModel(nil, []acquisition.Tag{{ID: "t1", Name: "New"}})
	if tag, ok := p.TagByName("New"); !ok || tag.ID != "t1" {
		t.Fatalf("TagByName after SetModel = %+v, %v", tag, ok)
	}
}
