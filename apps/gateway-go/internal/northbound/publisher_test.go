package northbound

import (
	"context"
	"math"
	"os"
	"path/filepath"
	"testing"

	"github.com/factorybridge/iotconnector/gateway-go/internal/db"
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

func TestDBQueueSurvivesRestartAndImportsLegacy(t *testing.T) {
	dir := t.TempDir()
	legacy := filepath.Join(dir, "northbound.json")
	old := New(Config{Enabled: true}, legacy, nil, nil)
	old.publishOrQueue("spBv1.0/G/NDATA/E", []byte("a"))
	old.publishOrQueue("spBv1.0/G/NDATA/E", []byte("b"))
	_ = old.nextSeq()

	database, err := db.Open(context.Background(), dir)
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	batch := db.NewBatch(database)
	p := NewDB(Config{Enabled: true}, database, batch, legacy, nil, nil)
	if got := p.Status().Queued; got != 2 {
		t.Fatalf("imported queue=%d", got)
	}
	if _, err := os.Stat(legacy + ".migrated"); err != nil {
		t.Fatalf("legacy not renamed: %v", err)
	}
	seq := p.Status().Seq
	p.publishOrQueue("spBv1.0/G/DDATA/E/d1", []byte("x"))
	p.publishOrQueue("spBv1.0/G/DDATA/E/d1", []byte("y")) // 合并，不新增
	_ = p.nextSeq()
	if err := batch.Flush(context.Background()); err != nil {
		t.Fatal(err)
	}
	restarted := NewDB(Config{Enabled: true}, database, batch, legacy, nil, nil)
	status := restarted.Status()
	if status.Queued != 3 || status.Seq != seq+1 {
		t.Fatalf("after restart queued=%d seq=%d (want 3, %d)", status.Queued, status.Seq, seq+1)
	}
	if string(restarted.queue[2].Payload) != "y" {
		t.Fatalf("coalesced payload not persisted: %q", restarted.queue[2].Payload)
	}
	restarted.publishOrQueue("spBv1.0/G/NDATA/E", []byte("c"))
	if err := batch.Flush(context.Background()); err != nil {
		t.Fatalf("id collision after restart: %v", err)
	}
}

func TestDBImportDropsEmptyLegacyPayloads(t *testing.T) {
	dir := t.TempDir()
	legacy := filepath.Join(dir, "northbound.json")
	mustWriteFile(t, legacy, `{"BDSeq":4,"Seq":10,"Queue":[{"topic":"a","payload":null},{"topic":"b","payload":"eA=="}],"Dropped":0}`)
	database, err := db.Open(context.Background(), dir)
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	p := NewDB(Config{}, database, db.NewBatch(database), legacy, nil, nil)
	status := p.Status()
	if status.Queued != 1 || status.Dropped != 1 || status.Seq != 10 {
		t.Fatalf("status=%+v", status)
	}
	if _, err := os.Stat(legacy + ".migrated"); err != nil {
		t.Fatalf("legacy not renamed after import: %v", err)
	}
}

func mustWriteFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
}
