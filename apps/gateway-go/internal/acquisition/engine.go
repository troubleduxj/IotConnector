package acquisition

import (
	"context"
	"fmt"
	"strconv"
	"strings"
	"sync"
	"time"
)

type Engine struct {
	mu                 sync.RWMutex
	channels           []Channel
	tags               []Tag
	drivers            map[string]Driver
	statuses           map[string]ChannelStatus
	snapshots          map[string]Sample
	factory            DriverFactory
	onSample           func(Sample)
	onStatus           func(ChannelStatus)
	runCtx             context.Context
	samplesTotal       uint64
	statusUpdates      uint64
	offlineTransitions uint64
	recoveries         uint64
	latencyTotalMs     uint64
	latencySamples     uint64
	lastLatencyMs      int64
	previousStates     map[string]string
	stats              map[string]*channelStats
	tagChannel         map[string]string
}

// RuntimeMetrics is the low-cardinality acquisition health snapshot exposed by
// the API. Per-tag values remain available through Snapshot and /api/tags/live.
type RuntimeMetrics struct {
	SamplesTotal       uint64 `json:"samplesTotal"`
	StatusUpdates      uint64 `json:"statusUpdates"`
	Channels           int    `json:"channels"`
	Online             int    `json:"online"`
	Offline            int    `json:"offline"`
	Connecting         int    `json:"connecting"`
	Disabled           int    `json:"disabled"`
	Error              int    `json:"error"`
	Unknown            int    `json:"unknown"`
	OfflineTransitions uint64 `json:"offlineTransitions"`
	Recoveries         uint64 `json:"recoveries"`
	LatencyTotalMs     uint64 `json:"latencyTotalMs"`
	LatencySamples     uint64 `json:"latencySamples"`
	LastLatencyMs      int64  `json:"lastLatencyMs"`
}

func NewEngine(channels []Channel, tags []Tag, factory DriverFactory) *Engine {
	return &Engine{
		channels:       append([]Channel(nil), channels...),
		tags:           append([]Tag(nil), tags...),
		drivers:        make(map[string]Driver),
		statuses:       make(map[string]ChannelStatus),
		snapshots:      make(map[string]Sample),
		previousStates: make(map[string]string),
		factory:        factory,
		tagChannel:     buildTagChannel(tags),
	}
}

// SetOnSample registers the runtime event sink used by the API layer.
func (e *Engine) SetOnSample(callback func(Sample)) {
	e.mu.Lock()
	e.onSample = callback
	e.mu.Unlock()
}

// SetOnStatus registers the runtime channel-status event sink.
func (e *Engine) SetOnStatus(callback func(ChannelStatus)) {
	e.mu.Lock()
	e.onStatus = callback
	e.mu.Unlock()
}

func (e *Engine) Start(ctx context.Context) error {
	e.mu.Lock()
	e.runCtx = ctx
	channels := append([]Channel(nil), e.channels...)
	e.mu.Unlock()
	for _, channel := range channels {
		if !channel.Enabled {
			e.setStatus(ChannelStatus{ID: channel.ID, State: "disabled"})
			continue
		}
		if e.factory == nil {
			e.setStatus(ChannelStatus{ID: channel.ID, State: "disabled", Detail: "no driver factory configured"})
			continue
		}
		channelTags := e.tagsForChannel(channel.ID)
		driver := e.factory(channel, channelTags, e.publish, e.setStatus)
		if driver == nil {
			e.setStatus(ChannelStatus{ID: channel.ID, State: "error", Detail: "driver factory returned nil"})
			continue
		}
		e.mu.Lock()
		e.drivers[channel.ID] = driver
		e.mu.Unlock()
		e.setStatus(ChannelStatus{ID: channel.ID, State: "connecting"})
		if err := driver.Start(ctx); err != nil {
			e.setStatus(ChannelStatus{ID: channel.ID, State: "error", Detail: err.Error()})
			continue
		}
		e.setStatus(ChannelStatus{ID: channel.ID, State: "online"})
	}
	return nil
}

// Reload replaces channels and tags while keeping the engine's parent context.
// It is used by configuration APIs so persisted edits take effect immediately.
func (e *Engine) Reload(ctx context.Context, channels []Channel, tags []Tag) error {
	if err := e.Stop(ctx); err != nil {
		return err
	}
	e.mu.Lock()
	runCtx := e.runCtx
	if runCtx == nil {
		runCtx = context.Background()
	}
	e.channels = append([]Channel(nil), channels...)
	e.tags = append([]Tag(nil), tags...)
	e.tagChannel = buildTagChannel(tags)
	e.drivers = make(map[string]Driver)
	e.statuses = make(map[string]ChannelStatus)
	e.snapshots = make(map[string]Sample)
	e.mu.Unlock()
	return e.Start(runCtx)
}

func (e *Engine) tagsForChannel(channelID string) []Tag {
	e.mu.RLock()
	defer e.mu.RUnlock()
	tags := make([]Tag, 0)
	for _, tag := range e.tags {
		if tag.ChannelID == channelID {
			tags = append(tags, tag)
		}
	}
	return tags
}

func (e *Engine) Stop(ctx context.Context) error {
	e.mu.RLock()
	drivers := make([]Driver, 0, len(e.drivers))
	for _, driver := range e.drivers {
		drivers = append(drivers, driver)
	}
	e.mu.RUnlock()

	var firstErr error
	for _, driver := range drivers {
		if err := driver.Stop(ctx); err != nil && firstErr == nil {
			firstErr = err
		}
	}
	return firstErr
}

func (e *Engine) Snapshot() []Sample {
	e.mu.RLock()
	defer e.mu.RUnlock()
	result := make([]Sample, 0, len(e.snapshots))
	for _, sample := range e.snapshots {
		result = append(result, sample)
	}
	return result
}

func (e *Engine) SnapshotValue(tagID string) any {
	e.mu.RLock()
	defer e.mu.RUnlock()
	sample, ok := e.snapshots[tagID]
	if !ok {
		return nil
	}
	if sample.Value.Number != nil {
		return *sample.Value.Number
	}
	if sample.Value.Bool != nil {
		return *sample.Value.Bool
	}
	if sample.Value.String != nil {
		return *sample.Value.String
	}
	return nil
}

func (e *Engine) SnapshotByID(tagID string) (Sample, bool) {
	e.mu.RLock()
	defer e.mu.RUnlock()
	sample, ok := e.snapshots[tagID]
	return sample, ok
}

func (e *Engine) Statuses() []ChannelStatus {
	e.mu.RLock()
	defer e.mu.RUnlock()
	result := make([]ChannelStatus, 0, len(e.statuses))
	for _, status := range e.statuses {
		result = append(result, status)
	}
	return result
}

func (e *Engine) Metrics() RuntimeMetrics {
	e.mu.RLock()
	defer e.mu.RUnlock()
	metrics := RuntimeMetrics{
		SamplesTotal:       e.samplesTotal,
		StatusUpdates:      e.statusUpdates,
		Channels:           len(e.channels),
		OfflineTransitions: e.offlineTransitions,
		Recoveries:         e.recoveries,
		LatencyTotalMs:     e.latencyTotalMs,
		LatencySamples:     e.latencySamples,
		LastLatencyMs:      e.lastLatencyMs,
	}
	for _, status := range e.statuses {
		switch status.State {
		case "online":
			metrics.Online++
		case "offline":
			metrics.Offline++
		case "connecting":
			metrics.Connecting++
		case "disabled":
			metrics.Disabled++
		case "error":
			metrics.Error++
		default:
			metrics.Unknown++
		}
	}
	return metrics
}

func (e *Engine) Write(ctx context.Context, tagID string, value Value) error {
	e.mu.RLock()
	var tag Tag
	var found bool
	for _, candidate := range e.tags {
		if candidate.ID == tagID {
			tag, found = candidate, true
			break
		}
	}
	driver := e.drivers[tag.ChannelID]
	e.mu.RUnlock()
	if !found {
		return fmt.Errorf("unknown tag: %s", tagID)
	}
	if driver == nil {
		return fmt.Errorf("channel driver unavailable: %s", tag.ChannelID)
	}
	if err := driver.Write(ctx, tag, value); err != nil {
		return err
	}
	e.publish(Sample{TagID: tag.ID, Value: value, Quality: QualityGood, SampledAt: time.Now().UnixMilli(), ReceivedAt: time.Now().UnixMilli()})
	return nil
}

func (e *Engine) publish(sample Sample) {
	if sample.ReceivedAt == 0 {
		sample.ReceivedAt = time.Now().UnixMilli()
	}
	e.mu.Lock()
	e.samplesTotal++
	e.snapshots[sample.TagID] = sample
	e.recordSampleLocked(sample.TagID, sample.ReceivedAt)
	callback := e.onSample
	e.mu.Unlock()
	if callback != nil {
		callback(sample)
	}
}

func (e *Engine) setStatus(status ChannelStatus) {
	e.mu.Lock()
	e.statusUpdates++
	previous := e.previousStates[status.ID]
	if status.State == "offline" && previous != "offline" {
		e.offlineTransitions++
	}
	if status.State == "online" && previous == "offline" {
		e.recoveries++
	}
	latency, hasLatency := statusLatency(status.Detail)
	if hasLatency {
		e.latencyTotalMs += uint64(latency)
		e.latencySamples++
		e.lastLatencyMs = latency
	}
	e.recordStatusLocked(status, previous, latency, hasLatency)
	e.previousStates[status.ID] = status.State
	e.statuses[status.ID] = status
	callback := e.onStatus
	e.mu.Unlock()
	if callback != nil {
		callback(status)
	}
}

func statusLatency(detail string) (int64, bool) {
	if !strings.Contains(detail, "OK ") {
		return 0, false
	}
	for _, field := range strings.Fields(detail) {
		if !strings.HasSuffix(field, "ms") {
			continue
		}
		value, err := strconv.ParseInt(strings.TrimSuffix(field, "ms"), 10, 64)
		if err == nil && value >= 0 {
			return value, true
		}
	}
	return 0, false
}
