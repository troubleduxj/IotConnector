package api

import (
	"context"
	"os"
	"path/filepath"
	"strconv"
	"testing"
	"time"

	"github.com/factorybridge/iotconnector/gateway-go/internal/acquisition"
	"github.com/factorybridge/iotconnector/gateway-go/internal/db"
	"github.com/factorybridge/iotconnector/gateway-go/internal/domain"
)

func newTestState(t *testing.T) *stateStore {
	t.Helper()
	database, err := db.Open(context.Background(), t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { database.Close() })
	return &stateStore{db: database, batch: db.NewBatch(database)}
}

func TestHistoryStorePersistsAndRecoversSamples(t *testing.T) {
	state := newTestState(t)
	now := time.Now().UnixMilli()
	store := newHistoryStore(state, "")
	store.add(acquisition.Sample{TagID: "tag-1", SampledAt: now - 1000, Value: acquisition.NumberValue(12.5)})
	store.add(acquisition.Sample{TagID: "tag-1", SampledAt: now, Value: acquisition.NumberValue(13.5)})
	store.add(acquisition.Sample{TagID: "bool-1", SampledAt: now, Value: acquisition.BoolValue(true)})
	if err := state.batch.Flush(context.Background()); err != nil {
		t.Fatal(err)
	}

	recovered := newHistoryStore(state, "")
	points := recovered.query([]string{"tag-1"}, 0, now+1)["tag-1"]
	if len(points) != 2 || points[0].Value != 12.5 || points[1].Value != 13.5 {
		t.Fatalf("unexpected recovered history: %#v", points)
	}
	if got := recovered.query([]string{"bool-1"}, 0, now+1)["bool-1"]; len(got) != 0 {
		t.Fatalf("bool sample should not enter numeric history: %#v", got)
	}
}

// G5：旧 history.jsonl 导入时跳过损坏行与超出保留期的点，导入后原文件改名。
func TestHistoryImportSkipsMalformedAndExpired(t *testing.T) {
	state := newTestState(t)
	now := time.Now().UnixMilli()
	old := time.Now().Add(-historyRetention - time.Hour).UnixMilli()
	path := filepath.Join(t.TempDir(), "history.jsonl")
	content := "not-json\n" +
		`{"tagId":"tag-1","ts":` + strconv.FormatInt(now, 10) + `,"value":7}` + "\n" +
		`{"tagId":"tag-1","ts":` + strconv.FormatInt(old, 10) + `,"value":1}` + "\n"
	if err := os.WriteFile(path, []byte(content), 0o640); err != nil {
		t.Fatal(err)
	}
	store := newHistoryStore(state, path)
	points := store.query([]string{"tag-1"}, 0, now+1)["tag-1"]
	if len(points) != 1 || points[0].Value != 7 {
		t.Fatalf("import result: %#v", points)
	}
	if _, err := os.Stat(path + ".migrated"); err != nil {
		t.Fatalf("legacy file not renamed: %v", err)
	}
}

func TestHistoryPruneKeepsPerTagLimit(t *testing.T) {
	state := newTestState(t)
	now := time.Now().UnixMilli()
	for i := 0; i < historyPointsPerTag+50; i++ {
		state.addHistory("tag-1", historyPoint{TS: now - int64(i), Value: float64(i)})
	}
	state.addHistory("tag-1", historyPoint{TS: time.Now().Add(-historyRetention - time.Hour).UnixMilli(), Value: -1})
	state.prune(context.Background())
	var n int
	_ = state.db.QueryRow(`SELECT COUNT(*) FROM history_points`).Scan(&n)
	if n != historyPointsPerTag {
		t.Fatalf("rows after prune=%d want %d", n, historyPointsPerTag)
	}
}

// 告警历史写入 SQLite：重启后恢复，确认（ack）更新同一事件，分页可查到超出内存缓存的旧事件。
func TestAlarmHistoryPersistsAcrossRestart(t *testing.T) {
	state := newTestState(t)
	manager := newAlarmManager([]any{map[string]any{"id": "r1", "tagId": "t1", "kind": "high", "threshold": 10.0, "hysteresis": 1.0, "enabled": true}})
	manager.state = state
	manager.stormLimit = 0 // 本测试快速循环触发，关闭风暴抑制（其行为由 B4 的测试覆盖）
	tag := domain.Tag{ID: "t1", Name: "T1"}
	for i := 0; i < alarmHistoryLimit+30; i++ {
		manager.evaluate(tag, acquisition.Sample{TagID: "t1", Value: acquisition.NumberValue(20)})
		manager.evaluate(tag, acquisition.Sample{TagID: "t1", Value: acquisition.NumberValue(0)})
	}
	if len(manager.history) != alarmHistoryLimit {
		t.Fatalf("in-memory history=%d", len(manager.history))
	}
	newest := manager.history[0]
	newest.Ack = map[string]any{"user": "op"}
	state.saveAlarmEvent(newest)

	events, total, err := state.queryAlarmHistory(context.Background(), 0, 10)
	if err != nil {
		t.Fatal(err)
	}
	if total != 2*(alarmHistoryLimit+30) || len(events) != 10 {
		t.Fatalf("total=%d page=%d", total, len(events))
	}
	if events[0].ID != newest.ID || events[0].Ack["user"] != "op" {
		t.Fatalf("ack not persisted on newest event: %+v", events[0])
	}
	restored := state.loadAlarmHistory(context.Background(), alarmHistoryLimit)
	if len(restored) != alarmHistoryLimit || restored[0].ID != newest.ID {
		t.Fatalf("restored %d events, first=%v", len(restored), restored[0].ID)
	}
}
