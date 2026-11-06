package acquisition

import (
	"context"
	"fmt"
	"math"
	"sync"
	"time"
)

type simulationDriver struct {
	channel   Channel
	tags      []Tag
	publish   func(Sample)
	setStatus func(ChannelStatus)
	mu        sync.Mutex
	values    map[string]Value
	cancel    context.CancelFunc
	done      chan struct{}
	sequence  uint64
}

func newSimulationDriver(channel Channel, tags []Tag, publish func(Sample), setStatus func(ChannelStatus)) Driver {
	return &simulationDriver{
		channel: channel, tags: tags, publish: publish, setStatus: setStatus,
		values: make(map[string]Value),
	}
}

func (d *simulationDriver) Start(parent context.Context) error {
	d.mu.Lock()
	if d.cancel != nil {
		d.mu.Unlock()
		return nil
	}
	ctx, cancel := context.WithCancel(parent)
	d.cancel = cancel
	d.done = make(chan struct{})
	done := d.done
	d.mu.Unlock()

	interval := time.Duration(d.channel.PollIntervalMs) * time.Millisecond
	if interval < 200*time.Millisecond {
		interval = 200 * time.Millisecond
	}
	go d.loop(ctx, interval, done)
	return nil
}

func (d *simulationDriver) Stop(ctx context.Context) error {
	d.mu.Lock()
	cancel, done := d.cancel, d.done
	d.cancel = nil
	d.mu.Unlock()
	if cancel == nil {
		return nil
	}
	cancel()
	select {
	case <-done:
		d.mu.Lock()
		if d.done == done {
			d.done = nil
		}
		d.mu.Unlock()
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (d *simulationDriver) Read(_ context.Context, tags []Tag) ([]Sample, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	now := time.Now().UnixMilli()
	result := make([]Sample, 0, len(tags))
	for _, tag := range tags {
		result = append(result, Sample{TagID: tag.ID, Value: d.valueFor(tag), Quality: QualityGood, SampledAt: now, ReceivedAt: now})
	}
	return result, nil
}

func (d *simulationDriver) Write(_ context.Context, tag Tag, value Value) error {
	if value.Number == nil && value.String == nil && value.Bool == nil {
		return fmt.Errorf("empty value for tag %s", tag.ID)
	}
	d.mu.Lock()
	d.values[tag.ID] = value
	d.mu.Unlock()
	return nil
}

func (d *simulationDriver) Test(context.Context, []Tag) error { return nil }

func (d *simulationDriver) loop(ctx context.Context, interval time.Duration, done chan struct{}) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	defer close(done)
	d.setStatus(ChannelStatus{ID: d.channel.ID, State: "online", Detail: "simulation"})
	for {
		select {
		case <-ctx.Done():
			d.setStatus(ChannelStatus{ID: d.channel.ID, State: "disabled", Detail: "stopped"})
			return
		case <-ticker.C:
			d.mu.Lock()
			d.sequence++
			d.mu.Unlock()
			now := time.Now().UnixMilli()
			for _, tag := range d.tags {
				d.mu.Lock()
				value := d.valueFor(tag)
				d.mu.Unlock()
				d.publish(Sample{TagID: tag.ID, Value: value, Quality: QualityGood, SampledAt: now, ReceivedAt: now})
			}
		}
	}
}

func (d *simulationDriver) valueFor(tag Tag) Value {
	if value, ok := d.values[tag.ID]; ok {
		return value
	}
	switch tag.DataType {
	case "Bool":
		return BoolValue(d.sequence%2 == 0)
	case "String":
		return StringValue(fmt.Sprintf("sim-%d", d.sequence%10))
	default:
		return NumberValue(math.Round((50+25*math.Sin(float64(d.sequence)/5))*100) / 100)
	}
}
