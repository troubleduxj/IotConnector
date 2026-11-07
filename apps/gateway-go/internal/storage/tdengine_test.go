package storage

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/factorybridge/iotconnector/gateway-go/internal/acquisition"
	"github.com/factorybridge/iotconnector/gateway-go/internal/db"
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
	database, batch := openState(t)
	first := New(Config{URL: "http://127.0.0.1:1", StateDB: database, State: batch})
	first.Enqueue(acquisition.Tag{ID: "tag-1", Name: "Temperature", ChannelID: "ch-1", DataType: "Float"}, acquisition.Sample{TagID: "tag-1", SampledAt: 1000, Value: acquisition.NumberValue(12.5)})
	if err := batch.Flush(context.Background()); err != nil {
		t.Fatal(err)
	}
	recovered := New(Config{URL: "http://127.0.0.1:1", StateDB: database, State: batch})
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

// 发送与入队交错、发送中队首溢出时，按 id 删除已发送的条目，不误删新入队的点，重启后队列与内存一致。
func TestWriterOutboxSurvivesRestartAfterPartialFlush(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "application/json")
		_, _ = w.Write([]byte(`{"code":0,"msg":"success"}`))
	}))
	defer server.Close()
	database, batch := openState(t)
	writer := New(Config{URL: server.URL, StateDB: database, State: batch})
	tag := acquisition.Tag{ID: "tag-1", Name: "Temperature", ChannelID: "ch-1", DataType: "Float"}
	for i := 0; i < maxInsertPoints+20; i++ {
		writer.Enqueue(tag, acquisition.Sample{TagID: "tag-1", SampledAt: int64(i), Value: acquisition.NumberValue(float64(i))})
	}
	if err := writer.Flush(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := batch.Flush(context.Background()); err != nil {
		t.Fatal(err)
	}
	var rows int
	_ = database.QueryRow(`SELECT COUNT(*) FROM outbox_points`).Scan(&rows)
	if rows != 20 || writer.Status().Queued != 20 {
		t.Fatalf("after partial flush: rows=%d queued=%d", rows, writer.Status().Queued)
	}
	restarted := New(Config{URL: server.URL, StateDB: database, State: batch})
	if restarted.Status().Queued != 20 {
		t.Fatalf("restart queued=%d", restarted.Status().Queued)
	}
	// 重启后继续分配的 id 不得与残留行冲突
	restarted.Enqueue(tag, acquisition.Sample{TagID: "tag-1", SampledAt: 9999, Value: acquisition.NumberValue(1)})
	if err := batch.Flush(context.Background()); err != nil {
		t.Fatalf("id collision after restart: %v", err)
	}
}

// G5：旧 JSON 队列（含分段文件）在首次启动时导入 SQLite，导入落盘后原文件改名为 .migrated。
func TestWriterImportsLegacyJSONOutbox(t *testing.T) {
	dir := t.TempDir()
	queueFile := filepath.Join(dir, "outbox.json")
	alarmFile := filepath.Join(dir, "alarm-outbox.json")
	mustWrite(t, queueFile, `[]`)
	mustWrite(t, queueFile+".part-000000", `[{"tagId":"a","tagName":"A","channel":"c","dataType":"Float","value":1,"ts":1},{"tagId":"a","tagName":"A","channel":"c","dataType":"Float","value":2,"ts":2}]`)
	mustWrite(t, queueFile+".part-000001", `[{"tagId":"b","tagName":"B","channel":"c","dataType":"Float","value":3,"ts":3}]`)
	mustWrite(t, alarmFile, `[{"ID":"e1","RuleID":"r1","TagID":"a","State":"Active","Timestamp":5}]`)
	database, batch := openState(t)
	writer := New(Config{URL: "http://127.0.0.1:1", StateDB: database, State: batch, QueueFile: queueFile, AlarmQueueFile: alarmFile})
	if got := writer.Status().Queued; got != 4 {
		t.Fatalf("imported queued=%d want 4 (3 points + 1 alarm)", got)
	}
	for _, f := range []string{queueFile, queueFile + ".part-000000", queueFile + ".part-000001", alarmFile} {
		if _, err := os.Stat(f + ".migrated"); err != nil {
			t.Fatalf("%s not renamed: %v", f, err)
		}
	}
	again := New(Config{URL: "http://127.0.0.1:1", StateDB: database, State: batch, QueueFile: queueFile, AlarmQueueFile: alarmFile})
	if got := again.Status().Queued; got != 4 {
		t.Fatalf("second start queued=%d (must not import twice)", got)
	}
}

func openState(t *testing.T) (*db.DB, *db.Batch) {
	t.Helper()
	database, err := db.Open(context.Background(), t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { database.Close() })
	return database, db.NewBatch(database)
}

func mustWrite(t *testing.T, path, content string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
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
