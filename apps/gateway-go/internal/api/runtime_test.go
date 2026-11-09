package api

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/factorybridge/iotconnector/gateway-go/internal/acquisition"
	"github.com/factorybridge/iotconnector/gateway-go/internal/config"
	"github.com/factorybridge/iotconnector/gateway-go/internal/domain"
	"github.com/factorybridge/iotconnector/gateway-go/internal/storage"
)

// fakeHost 是只实现 runtimeHost 的最小宿主：证明脚本与存储任务引擎不再依赖 *Server。
type fakeHost struct {
	mu      sync.Mutex
	current config.Config
	engine  *acquisition.Engine
	commits map[string]any
}

func (h *fakeHost) cfg() *config.Config {
	h.mu.Lock()
	defer h.mu.Unlock()
	c := h.current.Clone()
	return &c
}
func (h *fakeHost) commitRawLocked(key string, value any) error {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.current.Raw == nil {
		h.current.Raw = map[string]any{}
	}
	h.current.Raw[key] = value
	h.commits[key] = value
	return nil
}
func (h *fakeHost) lockConfig()                            {}
func (h *fakeHost) unlockConfig()                          {}
func (h *fakeHost) acquisition() *acquisition.Engine       { return h.engine }
func (h *fakeHost) storageWriter() *storage.Writer         { return nil }
func (h *fakeHost) storageDB() string                      { return "factory_bridge" }
func (h *fakeHost) storageTasksSnapshot() []map[string]any { return nil }

func TestScriptEngineRunsAgainstMinimalHost(t *testing.T) {
	t.Setenv("FB_SCRIPT_INLINE", "1") // 进程内执行，测试不依赖子进程
	written := make(chan acquisition.Value, 1)
	engine := acquisition.NewEngine(
		[]acquisition.Channel{{ID: "ch", Enabled: true}},
		[]acquisition.Tag{{ID: "t-out", ChannelID: "ch", Name: "Out"}},
		func(acquisition.Channel, []acquisition.Tag, func(acquisition.Sample), func(acquisition.ChannelStatus)) acquisition.Driver {
			return recordingDriver{written: written}
		},
	)
	if err := engine.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = engine.Stop(context.Background()) })
	host := &fakeHost{engine: engine, commits: map[string]any{}, current: config.Config{
		Tags: []domain.Tag{{ID: "t-out", ChannelID: "ch", Name: "Out", Address: "1"}},
		Raw:  map[string]any{"scripts": []any{map[string]any{"id": "s1", "name": "s", "code": `Write("Out", 42)`, "enabled": true, "trigger": map[string]any{"type": "manual"}}}},
	}}
	scripts := newScriptEngine(host)
	result, err := scripts.run("s1")
	if err != nil || result["ok"] != true {
		t.Fatalf("run = %v, %v", result, err)
	}
	select {
	case value := <-written:
		if value.Number == nil || *value.Number != 42 {
			t.Fatalf("written value = %+v", value)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("script write did not reach the driver")
	}
	if err := scripts.save(scripts.scripts()); err != nil || host.commits["scripts"] == nil {
		t.Fatalf("save through host: %v", err)
	}
}

type recordingDriver struct{ written chan acquisition.Value }

func (recordingDriver) Start(context.Context) error { return nil }
func (recordingDriver) Stop(context.Context) error  { return nil }
func (recordingDriver) Read(context.Context, []acquisition.Tag) ([]acquisition.Sample, error) {
	return nil, nil
}
func (recordingDriver) Test(context.Context, []acquisition.Tag) error { return nil }
func (d recordingDriver) Write(_ context.Context, _ acquisition.Tag, v acquisition.Value) error {
	d.written <- v
	return nil
}

// Runtime 把一个样本分发到历史、影子、告警和实时推送。
func TestRuntimeFansOutSample(t *testing.T) {
	cfg := config.Config{
		Tags: []domain.Tag{{ID: "t1", ChannelID: "ch", Name: "Temp", Address: "1"}},
		Raw: map[string]any{"alarms": []any{map[string]any{
			"id": "r1", "tagId": "t1", "kind": "high", "threshold": float64(10), "enabled": true,
		}}},
	}
	engine := acquisition.NewEngine(nil, nil, nil)
	server := NewServerWithOptions(cfg, engine, SecurityOptions{})
	value := 25.0
	server.runtime.onSample(acquisition.Sample{TagID: "t1", Value: acquisition.Value{Number: &value}, Quality: acquisition.QualityGood, SampledAt: time.Now().UnixMilli()})

	server.historyStore.mu.RLock()
	recorded := len(server.historyStore.values["t1"])
	server.historyStore.mu.RUnlock()
	if recorded == 0 {
		t.Fatal("sample not recorded in history")
	}
	if shadows := server.shadowSnapshot(); len(shadows) == 0 {
		t.Fatal("shadow not updated")
	}
	server.alarms.mu.RLock()
	active := len(server.alarms.active)
	server.alarms.mu.RUnlock()
	if active != 1 {
		t.Fatalf("active alarms = %d, want 1", active)
	}
	// 未知位号：不进告警，也不能让分发出错。
	server.runtime.onSample(acquisition.Sample{TagID: "ghost", Value: acquisition.Value{Number: &value}})
}

func TestDecodeAnyValueNumbers(t *testing.T) {
	for _, in := range []any{int64(42), 42, int32(42), float32(42), float64(42)} {
		if v := decodeAnyValue(in); v.Number == nil || *v.Number != 42 {
			t.Fatalf("decodeAnyValue(%T) = %+v, want number 42", in, v)
		}
	}
	if v := decodeAnyValue("42"); v.String == nil {
		t.Fatal("strings must stay strings")
	}
}
