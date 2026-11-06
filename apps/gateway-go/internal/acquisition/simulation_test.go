package acquisition

import (
	"context"
	"testing"
	"time"
)

func TestSimulationDriverPublishesAndStops(t *testing.T) {
	updates := make(chan Sample, 4)
	driver := newSimulationDriver(
		Channel{ID: "sim-1", PollIntervalMs: 200},
		[]Tag{{ID: "temp", DataType: "Float"}, {ID: "running", DataType: "Bool"}},
		func(sample Sample) { updates <- sample },
		func(ChannelStatus) {},
	)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	if err := driver.Start(ctx); err != nil {
		t.Fatal(err)
	}
	select {
	case <-updates:
	case <-time.After(2 * time.Second):
		t.Fatal("simulation driver did not publish")
	}
	if err := driver.Write(context.Background(), Tag{ID: "temp"}, NumberValue(99)); err != nil {
		t.Fatal(err)
	}
	if err := driver.Stop(context.Background()); err != nil {
		t.Fatal(err)
	}
}
