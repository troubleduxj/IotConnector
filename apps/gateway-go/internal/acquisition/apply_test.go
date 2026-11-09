package acquisition

import (
	"context"
	"sort"
	"sync"
	"testing"
)

// countingDriver 记录启停次数，用来判断哪些通道被重启。
type countingDriver struct {
	id    string
	stats *driverCounts
}

type driverCounts struct {
	mu      sync.Mutex
	starts  map[string]int
	stops   map[string]int
	created map[string][]Tag
}

func newDriverCounts() *driverCounts {
	return &driverCounts{starts: map[string]int{}, stops: map[string]int{}, created: map[string][]Tag{}}
}

func (d countingDriver) Start(context.Context) error {
	d.stats.mu.Lock()
	d.stats.starts[d.id]++
	d.stats.mu.Unlock()
	return nil
}
func (d countingDriver) Stop(context.Context) error {
	d.stats.mu.Lock()
	d.stats.stops[d.id]++
	d.stats.mu.Unlock()
	return nil
}
func (countingDriver) Read(context.Context, []Tag) ([]Sample, error) { return nil, nil }
func (countingDriver) Test(context.Context, []Tag) error             { return nil }
func (countingDriver) Write(context.Context, Tag, Value) error       { return nil }

func countingEngine(t *testing.T, channels []Channel, tags []Tag) (*Engine, *driverCounts) {
	t.Helper()
	counts := newDriverCounts()
	engine := NewEngine(channels, tags, func(c Channel, tags []Tag, _ func(Sample), _ func(ChannelStatus)) Driver {
		counts.mu.Lock()
		counts.created[c.ID] = append([]Tag(nil), tags...)
		counts.mu.Unlock()
		return countingDriver{id: c.ID, stats: counts}
	})
	if err := engine.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = engine.Stop(context.Background()) })
	return engine, counts
}

func (c *driverCounts) snapshot() (map[string]int, map[string]int) {
	c.mu.Lock()
	defer c.mu.Unlock()
	starts, stops := map[string]int{}, map[string]int{}
	for k, v := range c.starts {
		starts[k] = v
	}
	for k, v := range c.stops {
		stops[k] = v
	}
	return starts, stops
}

func baseConfig() ([]Channel, []Tag) {
	channels := []Channel{
		{ID: "a", Protocol: "Modbus TCP", Host: "10.0.0.1", Port: 502, Enabled: true, PollIntervalMs: 1000},
		{ID: "b", Protocol: "Modbus TCP", Host: "10.0.0.2", Port: 502, Enabled: true, PollIntervalMs: 1000},
		{ID: "c", Protocol: "Modbus TCP", Host: "10.0.0.3", Port: 502, Enabled: true, PollIntervalMs: 1000},
	}
	tags := []Tag{
		{ID: "a1", ChannelID: "a", Name: "A1", Address: "40001"},
		{ID: "b1", ChannelID: "b", Name: "B1", Address: "40001"},
		{ID: "c1", ChannelID: "c", Name: "C1", Address: "40001"},
	}
	return channels, tags
}

func TestApplyRestartsOnlyChangedChannel(t *testing.T) {
	channels, tags := baseConfig()
	engine, counts := countingEngine(t, channels, tags)
	engine.publish(Sample{TagID: "a1", Quality: QualityGood})
	engine.publish(Sample{TagID: "b1", Quality: QualityGood})

	next := append([]Channel(nil), channels...)
	next[1].PollIntervalMs = 500
	restarted, err := engine.Apply(context.Background(), next, tags)
	if err != nil {
		t.Fatal(err)
	}
	if len(restarted) != 1 || restarted[0] != "b" {
		t.Fatalf("restarted = %v, want [b]", restarted)
	}
	starts, stops := counts.snapshot()
	if starts["a"] != 1 || stops["a"] != 0 || starts["c"] != 1 || stops["c"] != 0 {
		t.Fatalf("unchanged channels were restarted: starts=%v stops=%v", starts, stops)
	}
	if starts["b"] != 2 || stops["b"] != 1 {
		t.Fatalf("changed channel not restarted once: starts=%v stops=%v", starts, stops)
	}
	if _, ok := engine.SnapshotByID("a1"); !ok {
		t.Fatal("snapshot of an unchanged channel was cleared")
	}
	if _, ok := engine.SnapshotByID("b1"); ok {
		t.Fatal("snapshot of the restarted channel should be cleared until it is read again")
	}
}

func TestApplyTagChangeRestartsOwningChannel(t *testing.T) {
	channels, tags := baseConfig()
	engine, counts := countingEngine(t, channels, tags)

	nextTags := append([]Tag(nil), tags...)
	nextTags = append(nextTags, Tag{ID: "c2", ChannelID: "c", Name: "C2", Address: "40002"})
	restarted, err := engine.Apply(context.Background(), channels, nextTags)
	if err != nil {
		t.Fatal(err)
	}
	if len(restarted) != 1 || restarted[0] != "c" {
		t.Fatalf("restarted = %v, want [c]", restarted)
	}
	counts.mu.Lock()
	created := counts.created["c"]
	counts.mu.Unlock()
	if len(created) != 2 {
		t.Fatalf("restarted driver got %d tags, want 2", len(created))
	}
}

func TestApplyAddsAndRemovesChannels(t *testing.T) {
	channels, tags := baseConfig()
	engine, counts := countingEngine(t, channels, tags)
	engine.publish(Sample{TagID: "c1", Quality: QualityGood})

	next := []Channel{channels[0], channels[1], {ID: "d", Protocol: "Modbus TCP", Host: "10.0.0.4", Port: 502, Enabled: true}}
	nextTags := []Tag{tags[0], tags[1], {ID: "d1", ChannelID: "d", Name: "D1", Address: "40001"}}
	restarted, err := engine.Apply(context.Background(), next, nextTags)
	if err != nil {
		t.Fatal(err)
	}
	sort.Strings(restarted)
	if len(restarted) != 2 || restarted[0] != "c" || restarted[1] != "d" {
		t.Fatalf("restarted = %v, want [c d]", restarted)
	}
	starts, stops := counts.snapshot()
	if stops["c"] != 1 || starts["d"] != 1 || starts["a"] != 1 || starts["b"] != 1 {
		t.Fatalf("starts=%v stops=%v", starts, stops)
	}
	for _, status := range engine.Statuses() {
		if status.ID == "c" {
			t.Fatal("removed channel still has a status")
		}
	}
	if _, ok := engine.SnapshotByID("c1"); ok {
		t.Fatal("removed channel's tag snapshot still present")
	}
	if err := engine.Write(context.Background(), "d1", NumberValue(1)); err != nil {
		t.Fatalf("new channel not writable: %v", err)
	}
}

func TestApplyNoChangeIsNoop(t *testing.T) {
	channels, tags := baseConfig()
	engine, counts := countingEngine(t, channels, tags)
	restarted, err := engine.Apply(context.Background(), channels, tags)
	if err != nil || len(restarted) != 0 {
		t.Fatalf("restarted = %v, err = %v", restarted, err)
	}
	starts, stops := counts.snapshot()
	if len(stops) != 0 || starts["a"] != 1 {
		t.Fatalf("starts=%v stops=%v", starts, stops)
	}
}

func TestApplyDisableChannelStopsDriver(t *testing.T) {
	channels, tags := baseConfig()
	engine, counts := countingEngine(t, channels, tags)
	next := append([]Channel(nil), channels...)
	next[0].Enabled = false
	if _, err := engine.Apply(context.Background(), next, tags); err != nil {
		t.Fatal(err)
	}
	starts, stops := counts.snapshot()
	if stops["a"] != 1 || starts["a"] != 1 {
		t.Fatalf("starts=%v stops=%v", starts, stops)
	}
	for _, status := range engine.Statuses() {
		if status.ID == "a" && status.State != "disabled" {
			t.Fatalf("channel a state = %s, want disabled", status.State)
		}
	}
	if err := engine.Write(context.Background(), "a1", NumberValue(1)); err == nil {
		t.Fatal("write to a disabled channel should fail")
	}
}
