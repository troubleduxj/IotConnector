package acquisition

import "testing"

func TestEngineMetrics(t *testing.T) {
	engine := NewEngine(
		[]Channel{{ID: "online"}, {ID: "offline"}, {ID: "disabled"}},
		nil,
		nil,
	)
	engine.setStatus(ChannelStatus{ID: "online", State: "online", Detail: "OK 12ms"})
	engine.setStatus(ChannelStatus{ID: "offline", State: "offline"})
	engine.setStatus(ChannelStatus{ID: "disabled", State: "disabled"})
	engine.setStatus(ChannelStatus{ID: "offline", State: "online", Detail: "OK 7ms"})
	engine.publish(Sample{TagID: "tag-1", Value: NumberValue(1)})
	engine.publish(Sample{TagID: "tag-1", Value: NumberValue(2)})

	metrics := engine.Metrics()
	if metrics.SamplesTotal != 2 || metrics.StatusUpdates != 4 {
		t.Fatalf("unexpected counters: %#v", metrics)
	}
	if metrics.Channels != 3 || metrics.Online != 2 || metrics.Offline != 0 || metrics.Disabled != 1 {
		t.Fatalf("unexpected channel states: %#v", metrics)
	}
	if metrics.OfflineTransitions != 1 || metrics.Recoveries != 1 || metrics.LatencyTotalMs != 19 || metrics.LatencySamples != 2 || metrics.LastLatencyMs != 7 {
		t.Fatalf("unexpected diagnostics: %#v", metrics)
	}
}
