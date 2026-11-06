package acquisition

import (
	"context"
	"fmt"
	"sync"
	"time"

	"github.com/gopcua/opcua"
	"github.com/gopcua/opcua/ua"
)

type opcuaDriver struct {
	channel   Channel
	tags      []Tag
	publish   func(Sample)
	setStatus func(ChannelStatus)
	mu        sync.Mutex
	client    *opcua.Client
	cancel    context.CancelFunc
	done      chan struct{}
}

func newOPCUADriver(channel Channel, tags []Tag, publish func(Sample), setStatus func(ChannelStatus)) Driver {
	return &opcuaDriver{channel: channel, tags: tags, publish: publish, setStatus: setStatus}
}

func (d *opcuaDriver) Start(parent context.Context) error {
	d.mu.Lock()
	if d.cancel != nil {
		d.mu.Unlock()
		return nil
	}
	ctx, cancel := context.WithCancel(parent)
	d.cancel = cancel
	d.done = make(chan struct{})
	d.mu.Unlock()
	go d.loop(ctx, d.done)
	return nil
}

func (d *opcuaDriver) Stop(ctx context.Context) error {
	d.mu.Lock()
	cancel, done, client := d.cancel, d.done, d.client
	d.cancel, d.client = nil, nil
	d.mu.Unlock()
	if client != nil {
		_ = client.Close(ctx)
	}
	if cancel == nil {
		return nil
	}
	cancel()
	select {
	case <-done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (d *opcuaDriver) Read(ctx context.Context, tags []Tag) ([]Sample, error) {
	d.mu.Lock()
	client, err := d.ensureClientLocked(ctx)
	d.mu.Unlock()
	if err != nil {
		return nil, err
	}
	result := make([]Sample, 0, len(tags))
	for _, tag := range tags {
		id, err := ua.ParseNodeID(tag.Address)
		if err != nil {
			return nil, fmt.Errorf("OPC UA node %s: %w", tag.Address, err)
		}
		value, err := client.Node(id).Value(ctx)
		if err != nil {
			return nil, err
		}
		converted, err := convertOPCUAValue(value.Value(), tag.DataType)
		if err != nil {
			return nil, fmt.Errorf("OPC UA node %s: %w", tag.Address, err)
		}
		now := time.Now().UnixMilli()
		result = append(result, Sample{TagID: tag.ID, Value: converted, Quality: QualityGood, SampledAt: now, ReceivedAt: now})
	}
	return result, nil
}

func (d *opcuaDriver) Write(ctx context.Context, tag Tag, value Value) error {
	id, err := ua.ParseNodeID(tag.Address)
	if err != nil {
		return err
	}
	var raw any
	switch tag.DataType {
	case "Bool":
		if value.Bool == nil {
			return fmt.Errorf("OPC UA Bool write requires bool value")
		}
		raw = *value.Bool
	case "String":
		if value.String == nil {
			return fmt.Errorf("OPC UA String write requires string value")
		}
		raw = *value.String
	default:
		if value.Number == nil {
			return fmt.Errorf("OPC UA numeric write requires numeric value")
		}
		switch tag.DataType {
		case "Float":
			// The simulator and the Node driver expose Float tags as OPC UA Double
			// variants. Keep the platform's numeric precision while matching the
			// server-side data type; a Float32 write is rejected as BadTypeMismatch.
			raw = *value.Number
		case "Int16":
			raw = int16(*value.Number)
		case "UInt16":
			raw = uint16(*value.Number)
		case "Int32":
			raw = int32(*value.Number)
		default:
			raw = *value.Number
		}
	}
	variant, err := ua.NewVariant(raw)
	if err != nil {
		return err
	}
	d.mu.Lock()
	client, err := d.ensureClientLocked(ctx)
	d.mu.Unlock()
	if err != nil {
		return err
	}
	response, err := client.Write(ctx, &ua.WriteRequest{NodesToWrite: []*ua.WriteValue{{
		NodeID: id, AttributeID: ua.AttributeIDValue,
		Value: &ua.DataValue{EncodingMask: ua.DataValueValue, Value: variant},
	}}})
	if err != nil {
		return err
	}
	if len(response.Results) == 0 || response.Results[0] != ua.StatusOK {
		if len(response.Results) == 0 {
			return fmt.Errorf("OPC UA write returned no status")
		}
		return fmt.Errorf("OPC UA write %s: %s", tag.Address, response.Results[0])
	}
	return nil
}

func (d *opcuaDriver) Test(ctx context.Context, tags []Tag) error {
	if len(tags) == 0 {
		return fmt.Errorf("OPC UA test requires at least one tag")
	}
	_, err := d.Read(ctx, tags[:1])
	return err
}

func (d *opcuaDriver) loop(ctx context.Context, done chan struct{}) {
	defer close(done)
	interval := time.Duration(d.channel.PollIntervalMs) * time.Millisecond
	if interval < 200*time.Millisecond {
		interval = 200 * time.Millisecond
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			d.setStatus(ChannelStatus{ID: d.channel.ID, State: "disabled", Detail: "stopped"})
			return
		default:
		}
		started := time.Now()
		if samples, err := d.Read(ctx, d.tags); err != nil {
			d.resetClient(ctx)
			d.setStatus(ChannelStatus{ID: d.channel.ID, State: "offline", Detail: err.Error()})
		} else {
			for _, sample := range samples {
				d.publish(sample)
			}
			d.setStatus(ChannelStatus{ID: d.channel.ID, State: "online", Detail: fmt.Sprintf("OK %d nodes %dms", len(samples), time.Since(started).Milliseconds())})
		}
		select {
		case <-ctx.Done():
		case <-ticker.C:
		}
	}
}

func (d *opcuaDriver) ensureClientLocked(ctx context.Context) (*opcua.Client, error) {
	if d.client != nil {
		return d.client, nil
	}
	p := d.channel.Params
	endpoint := stringParam(p, "endpointUrl", fmt.Sprintf("opc.tcp://%s:%d", d.channel.Host, d.channel.Port))
	options := []opcua.Option{opcua.SecurityModeString(stringParam(p, "securityMode", "None")), opcua.SecurityPolicy(stringParam(p, "securityPolicy", "None"))}
	if stringParam(p, "authType", "Anonymous") == "Username" {
		options = append(options, opcua.AuthUsername(stringParam(p, "username", ""), stringParam(p, "password", "")))
	} else {
		options = append(options, opcua.AuthAnonymous())
	}
	client, err := opcua.NewClient(endpoint, options...)
	if err != nil {
		return nil, err
	}
	if err := client.Connect(ctx); err != nil {
		return nil, err
	}
	d.client = client
	return client, nil
}

func (d *opcuaDriver) resetClient(ctx context.Context) {
	d.mu.Lock()
	client := d.client
	d.client = nil
	d.mu.Unlock()
	if client != nil {
		_ = client.Close(ctx)
	}
}

func convertOPCUAValue(value any, dataType string) (Value, error) {
	switch dataType {
	case "Bool":
		if v, ok := value.(bool); ok {
			return BoolValue(v), nil
		}
	case "String":
		if v, ok := value.(string); ok {
			return StringValue(v), nil
		}
	default:
		switch v := value.(type) {
		case float32:
			return NumberValue(float64(v)), nil
		case float64:
			return NumberValue(v), nil
		case int8:
			return NumberValue(float64(v)), nil
		case int16:
			return NumberValue(float64(v)), nil
		case int32:
			return NumberValue(float64(v)), nil
		case int64:
			return NumberValue(float64(v)), nil
		case uint8:
			return NumberValue(float64(v)), nil
		case uint16:
			return NumberValue(float64(v)), nil
		case uint32:
			return NumberValue(float64(v)), nil
		case uint64:
			return NumberValue(float64(v)), nil
		}
	}
	return Value{}, fmt.Errorf("unexpected value %T for %s", value, dataType)
}
