package northbound

import (
	"math"
	"path/filepath"
	"testing"
)

func TestQueueCoalescesBirthAndDataSnapshots(t *testing.T) {
	p := New(Config{Enabled: true}, filepath.Join(t.TempDir(), "northbound.json"), nil, nil)
	p.publishOrQueue("spBv1.0/Factory/NBIRTH/edge", []byte("birth-1"))
	p.publishOrQueue("spBv1.0/Factory/NBIRTH/edge", []byte("birth-2"))
	p.publishOrQueue("spBv1.0/Factory/DBIRTH/edge/device", []byte("device-1"))
	p.publishOrQueue("spBv1.0/Factory/DBIRTH/edge/device", []byte("device-2"))
	p.publishOrQueue("spBv1.0/Factory/DDATA/edge/device", []byte("data-1"))
	p.publishOrQueue("spBv1.0/Factory/DDATA/edge/device", []byte("data-2"))
	if got := len(p.queue); got != 3 {
		t.Fatalf("queue length = %d, want 3", got)
	}
	if string(p.queue[0].Payload) != "birth-2" || string(p.queue[1].Payload) != "device-2" || string(p.queue[2].Payload) != "data-2" {
		t.Fatalf("coalesced payloads = %#v", p.queue)
	}
}

func TestShadowQueueKeepsRetainFlag(t *testing.T) {
	p := New(Config{Enabled: true}, filepath.Join(t.TempDir(), "northbound.json"), nil, nil)
	p.publishOrQueueRetained("Factory/shadow/edge", []byte("v1"))
	p.publishOrQueueRetained("Factory/shadow/edge", []byte("v2"))
	if len(p.queue) != 1 || !p.queue[0].Retain || string(p.queue[0].Payload) != "v2" {
		t.Fatalf("shadow queue = %#v", p.queue)
	}
}

func TestNormalizeBrokerURL(t *testing.T) {
	tests := map[string]string{
		"mqtt://127.0.0.1:18840":    "tcp://127.0.0.1:18840",
		"mqtts://broker.example":    "ssl://broker.example",
		"tcp://127.0.0.1:1883":      "tcp://127.0.0.1:1883",
		"ssl://broker.example:8883": "ssl://broker.example:8883",
	}
	for input, want := range tests {
		if got := normalizeBrokerURL(input); got != want {
			t.Fatalf("normalizeBrokerURL(%q) = %q, want %q", input, got, want)
		}
	}
}

func TestDecodeSparkplugCommandMetrics(t *testing.T) {
	payload := encodePayload(1, []metric{
		{Name: "Speed", DataType: 4, Value: float64(42)},
		{Name: "Running", DataType: 12, Value: true},
		{Name: "Label", DataType: 13, Value: "ready"},
	}, 1)
	metrics := decodeCommandMetrics(payload)
	if len(metrics) != 3 {
		t.Fatalf("decoded %d metrics, want 3: %#v", len(metrics), metrics)
	}
	if metrics[0].Name != "Speed" || metrics[0].Value != float64(42) {
		t.Fatalf("speed = %#v", metrics[0])
	}
	if metrics[1].Name != "Running" || metrics[1].Value != true {
		t.Fatalf("running = %#v", metrics[1])
	}
	if metrics[2].Name != "Label" || metrics[2].Value != "ready" {
		t.Fatalf("label = %#v", metrics[2])
	}

	floatMetric := encodePayload(1, []metric{{Name: "Temperature", DataType: 10, Value: float64(36.5)}}, 1)
	decoded := decodeCommandMetrics(floatMetric)
	if len(decoded) != 1 || math.Abs(decoded[0].Value.(float64)-36.5) > 0.001 {
		t.Fatalf("float = %#v", decoded)
	}
}
