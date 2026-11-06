package storage

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/factorybridge/iotconnector/gateway-go/internal/acquisition"
)

func TestWriterQueuesAndFlushesToTDengine(t *testing.T) {
	var requests []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		requests = append(requests, string(body))
		w.Header().Set("content-type", "application/json")
		_, _ = w.Write([]byte(`{"code":0,"msg":"success"}`))
	}))
	defer server.Close()
	writer := New(Config{URL: server.URL, User: "root", Password: "taosdata", Database: "factory_bridge", SuperTable: "st_factory_equipment", QueueFile: filepath.Join(t.TempDir(), "outbox.json")})
	writer.Enqueue(acquisition.Tag{ID: "tag-1", Name: "Temperature", ChannelID: "ch-1", DataType: "Float"}, acquisition.Sample{TagID: "tag-1", SampledAt: 1000, Value: acquisition.NumberValue(12.5)})
	if writer.Status().Queued != 1 {
		t.Fatalf("queued=%d", writer.Status().Queued)
	}
	if err := writer.Flush(context.Background()); err != nil {
		t.Fatal(err)
	}
	status := writer.Status()
	if status.Queued != 0 || status.Written != 1 || status.State != "online" {
		t.Fatalf("unexpected status: %#v", status)
	}
	if len(requests) != 3 || !strings.Contains(requests[2], "INSERT INTO") {
		t.Fatalf("unexpected SQL requests: %#v", requests)
	}
}

func TestWriterRecoversOutboxWhenTDengineIsOffline(t *testing.T) {
	path := filepath.Join(t.TempDir(), "outbox.json")
	first := New(Config{URL: "http://127.0.0.1:1", QueueFile: path})
	first.Enqueue(acquisition.Tag{ID: "tag-1", Name: "Temperature", ChannelID: "ch-1", DataType: "Float"}, acquisition.Sample{TagID: "tag-1", SampledAt: 1000, Value: acquisition.NumberValue(12.5)})
	recovered := New(Config{URL: "http://127.0.0.1:1", QueueFile: path})
	if recovered.Status().Queued != 1 {
		t.Fatalf("recovered queued=%d", recovered.Status().Queued)
	}
}

func TestWriterSegmentsLargeInsertBatch(t *testing.T) {
	var inserts atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		if strings.Contains(string(body), "INSERT INTO") {
			inserts.Add(1)
		}
		w.Header().Set("content-type", "application/json")
		_, _ = w.Write([]byte(`{"code":0,"msg":"success"}`))
	}))
	defer server.Close()

	writer := New(Config{URL: server.URL, QueueFile: filepath.Join(t.TempDir(), "outbox.json")})
	for i := 0; i < 501; i++ {
		writer.Enqueue(acquisition.Tag{ID: "tag-1", Name: "Temperature", ChannelID: "ch-1", DataType: "Float"}, acquisition.Sample{
			TagID: "tag-1", SampledAt: int64(i), Value: acquisition.NumberValue(float64(i)),
		})
	}
	if err := writer.Flush(context.Background()); err != nil {
		t.Fatal(err)
	}
	if got := writer.Status().Queued; got != 1 {
		t.Fatalf("first flush should leave one point queued, got %d", got)
	}
	if err := writer.Flush(context.Background()); err != nil {
		t.Fatal(err)
	}
	status := writer.Status()
	if status.Queued != 0 || status.Written != 501 || inserts.Load() != 2 {
		t.Fatalf("unexpected segmented flush: status=%#v inserts=%d", status, inserts.Load())
	}
}

func TestWriterSegmentsAndRecoversOutbox(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "outbox.json")
	writer := New(Config{URL: "http://127.0.0.1:1", QueueFile: path, SegmentSize: 3, MaxQueue: 10})
	for i := 0; i < 8; i++ {
		writer.Enqueue(acquisition.Tag{ID: "tag-1", Name: "Temperature", ChannelID: "ch-1", DataType: "Float"}, acquisition.Sample{TagID: "tag-1", SampledAt: int64(i), Value: acquisition.NumberValue(float64(i))})
	}
	parts, err := filepath.Glob(path + ".part-*")
	if err != nil || len(parts) != 3 {
		t.Fatalf("expected 3 outbox segments, got %d (%v)", len(parts), err)
	}
	recovered := New(Config{URL: "http://127.0.0.1:1", QueueFile: path, SegmentSize: 3, MaxQueue: 10})
	if recovered.Status().Queued != 8 {
		t.Fatalf("recovered queued=%d", recovered.Status().Queued)
	}
}

func TestWriterDropsOldestWhenOutboxCapacityIsReached(t *testing.T) {
	writer := New(Config{URL: "http://127.0.0.1:1", MaxQueue: 2})
	for i := 0; i < 3; i++ {
		writer.Enqueue(acquisition.Tag{ID: "tag-1", Name: "Temperature"}, acquisition.Sample{TagID: "tag-1", SampledAt: int64(i), Value: acquisition.NumberValue(float64(i))})
	}
	status := writer.Status()
	if status.Queued != 2 || status.Dropped != 1 {
		t.Fatalf("unexpected capacity status: %#v", status)
	}
}

func TestWriterRecoversAfterTDengineWriteFailure(t *testing.T) {
	var available atomic.Bool
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !available.Load() {
			http.Error(w, "simulated TDengine outage", http.StatusServiceUnavailable)
			return
		}
		w.Header().Set("content-type", "application/json")
		_, _ = w.Write([]byte(`{"code":0,"msg":"success"}`))
	}))
	defer server.Close()

	writer := New(Config{URL: server.URL, QueueFile: filepath.Join(t.TempDir(), "outbox.json")})
	writer.Enqueue(acquisition.Tag{ID: "tag-1", Name: "Temperature", ChannelID: "ch-1", DataType: "Float"}, acquisition.Sample{TagID: "tag-1", SampledAt: 1000, Value: acquisition.NumberValue(12.5)})
	if err := writer.Flush(context.Background()); err == nil {
		t.Fatal("expected simulated TDengine outage")
	}
	failed := writer.Status()
	if failed.State != "offline" || failed.Queued != 1 {
		t.Fatalf("outage should preserve queue: %#v", failed)
	}

	available.Store(true)
	if err := writer.Flush(context.Background()); err != nil {
		t.Fatal(err)
	}
	recovered := writer.Status()
	if recovered.State != "online" || recovered.Queued != 0 || recovered.Written != 1 {
		t.Fatalf("unexpected recovery status: %#v", recovered)
	}
}
