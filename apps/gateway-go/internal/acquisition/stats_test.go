package acquisition

import "testing"

func TestChannelStatsCountSamplesErrorsAndCycles(t *testing.T) {
	e := NewEngine([]Channel{{ID: "c1"}, {ID: "c2"}}, []Tag{{ID: "t1", ChannelID: "c1"}, {ID: "t2", ChannelID: "c1"}, {ID: "t3", ChannelID: "c2"}}, nil)
	for i := 0; i < 3; i++ {
		e.publish(Sample{TagID: "t1"})
		e.publish(Sample{TagID: "t2"})
	}
	e.publish(Sample{TagID: "t3"})
	e.publish(Sample{TagID: "unknown"})
	e.setStatus(ChannelStatus{ID: "c1", State: "online", Detail: "OK 10ms"})
	e.setStatus(ChannelStatus{ID: "c1", State: "online", Detail: "OK 20ms"})
	e.setStatus(ChannelStatus{ID: "c1", State: "offline", Detail: "timeout"})
	e.setStatus(ChannelStatus{ID: "c1", State: "offline", Detail: "timeout"}) // 持续离线不重复计错
	e.setStatus(ChannelStatus{ID: "c1", State: "online", Detail: "OK 30ms"})

	stats := e.ChannelStats()
	c1 := stats["c1"]
	if c1.Samples != 6 || c1.Errors != 1 || c1.Cycles != 3 || c1.AvgCycleMs != 20 {
		t.Fatalf("c1 stats = %+v", c1)
	}
	if stats["c2"].Samples != 1 {
		t.Fatalf("c2 stats = %+v", stats["c2"])
	}
}

func TestChannelStatsSurviveReload(t *testing.T) {
	e := NewEngine([]Channel{{ID: "c1"}}, []Tag{{ID: "t1", ChannelID: "c1"}}, nil)
	e.publish(Sample{TagID: "t1"})
	if err := e.Reload(t.Context(), []Channel{{ID: "c1"}}, []Tag{{ID: "t1", ChannelID: "c1"}, {ID: "t9", ChannelID: "c1"}}); err != nil {
		t.Fatal(err)
	}
	e.publish(Sample{TagID: "t9"}) // 重载后新增的位号也归到通道
	if got := e.ChannelStats()["c1"].Samples; got != 2 {
		t.Fatalf("samples after reload = %d", got)
	}
}
