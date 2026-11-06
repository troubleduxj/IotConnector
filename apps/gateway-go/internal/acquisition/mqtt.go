package acquisition

import (
	"context"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
	"sync"
	"time"

	mqtt "github.com/eclipse/paho.mqtt.golang"
)

type mqttDriver struct {
	channel   Channel
	tags      []Tag
	publish   func(Sample)
	setStatus func(ChannelStatus)

	mu     sync.RWMutex
	latest map[string]Value
	client mqtt.Client
	cancel context.CancelFunc
	done   chan struct{}
}

func newMQTTDriver(channel Channel, tags []Tag, publish func(Sample), setStatus func(ChannelStatus)) Driver {
	return &mqttDriver{channel: channel, tags: tags, publish: publish, setStatus: setStatus, latest: make(map[string]Value)}
}

func (d *mqttDriver) Start(parent context.Context) error {
	d.mu.Lock()
	if d.cancel != nil {
		d.mu.Unlock()
		return nil
	}
	ctx, cancel := context.WithCancel(parent)
	d.cancel = cancel
	d.done = make(chan struct{})
	d.mu.Unlock()

	broker := fmt.Sprintf("tcp://%s:%d", d.channel.Host, d.channel.Port)
	opts := mqtt.NewClientOptions().AddBroker(broker).SetClientID("factorybridge-" + d.channel.ID)
	opts.SetAutoReconnect(true).SetConnectRetry(true).SetConnectRetryInterval(2 * time.Second)
	if username, ok := d.channel.Params["username"].(string); ok {
		opts.SetUsername(username)
	}
	if password, ok := d.channel.Params["password"].(string); ok {
		opts.SetPassword(password)
	}
	opts.OnConnect = func(client mqtt.Client) {
		for _, tag := range d.tags {
			if tag.Address == "" {
				continue
			}
			client.Subscribe(tag.Address, 0, d.onMessage)
		}
		d.setStatus(ChannelStatus{ID: d.channel.ID, State: "connecting", Detail: "MQTT connected; waiting for samples"})
	}
	opts.OnConnectionLost = func(_ mqtt.Client, err error) {
		d.setStatus(ChannelStatus{ID: d.channel.ID, State: "offline", Detail: "MQTT connection lost: " + err.Error()})
	}
	client := mqtt.NewClient(opts)
	token := client.Connect()
	if !token.WaitTimeout(5*time.Second) || token.Error() != nil {
		err := token.Error()
		if err == nil {
			err = fmt.Errorf("MQTT connection timeout")
		}
		d.mu.Lock()
		d.cancel()
		d.cancel = nil
		d.mu.Unlock()
		return fmt.Errorf("MQTT connect %s: %w", broker, err)
	}
	d.mu.Lock()
	d.client = client
	d.mu.Unlock()
	go d.loop(ctx)
	return nil
}

func (d *mqttDriver) Stop(ctx context.Context) error {
	d.mu.Lock()
	cancel, done, client := d.cancel, d.done, d.client
	d.cancel, d.client = nil, nil
	d.mu.Unlock()
	if cancel == nil {
		return nil
	}
	cancel()
	if client != nil && client.IsConnected() {
		client.Disconnect(250)
	}
	select {
	case <-done:
		d.setStatus(ChannelStatus{ID: d.channel.ID, State: "disabled", Detail: "stopped"})
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (d *mqttDriver) Read(ctx context.Context, tags []Tag) ([]Sample, error) {
	d.mu.RLock()
	values := make(map[string]Value, len(d.latest))
	for id, value := range d.latest {
		values[id] = value
	}
	d.mu.RUnlock()
	if len(values) == 0 {
		return nil, fmt.Errorf("MQTT has not received a sample")
	}
	now := time.Now().UnixMilli()
	result := make([]Sample, 0, len(tags))
	for _, tag := range tags {
		if value, ok := values[tag.ID]; ok {
			result = append(result, Sample{TagID: tag.ID, Value: value, Quality: QualityGood, SampledAt: now, ReceivedAt: now})
		}
	}
	if len(result) == 0 {
		return nil, fmt.Errorf("MQTT has no values for configured topics")
	}
	return result, nil
}

func (d *mqttDriver) Write(ctx context.Context, tag Tag, value Value) error {
	d.mu.RLock()
	client := d.client
	d.mu.RUnlock()
	if client == nil || !client.IsConnected() {
		return fmt.Errorf("MQTT is not connected")
	}
	payload := valueToJSON(value)
	token := client.Publish(tag.Address, 0, false, payload)
	if !token.WaitTimeout(3 * time.Second) {
		return fmt.Errorf("MQTT publish timeout")
	}
	return token.Error()
}

func (d *mqttDriver) Test(ctx context.Context, tags []Tag) error {
	_, err := d.Read(ctx, tags)
	return err
}

func (d *mqttDriver) loop(ctx context.Context) {
	defer close(d.done)
	interval := time.Duration(d.channel.PollIntervalMs) * time.Millisecond
	if interval < 200*time.Millisecond {
		interval = 200 * time.Millisecond
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		if samples, err := d.Read(ctx, d.tags); err == nil {
			for _, sample := range samples {
				d.publish(sample)
			}
			d.setStatus(ChannelStatus{ID: d.channel.ID, State: "online", Detail: fmt.Sprintf("OK %d samples", len(samples))})
		} else if ctx.Err() == nil {
			d.setStatus(ChannelStatus{ID: d.channel.ID, State: "offline", Detail: err.Error()})
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

func (d *mqttDriver) onMessage(_ mqtt.Client, message mqtt.Message) {
	d.mu.RLock()
	var tag *Tag
	for i := range d.tags {
		if d.tags[i].Address == message.Topic() {
			tag = &d.tags[i]
			break
		}
	}
	d.mu.RUnlock()
	if tag == nil {
		return
	}
	path := ""
	if dot := strings.LastIndex(tag.Name, "."); dot >= 0 {
		path = strings.ToLower(tag.Name[dot+1:])
	}
	value, ok := decodeMQTTValuePath(message.Payload(), tag.DataType, path)
	if ok {
		d.mu.Lock()
		d.latest[tag.ID] = value
		d.mu.Unlock()
	}
}

func decodeMQTTValue(payload []byte, dataType string) (Value, bool) {
	return decodeMQTTValuePath(payload, dataType, "")
}

func decodeMQTTValuePath(payload []byte, dataType, path string) (Value, bool) {
	var envelope struct {
		Value any `json:"value"`
	}
	var object map[string]any
	if json.Unmarshal(payload, &object) == nil {
		var selected any
		if path != "" {
			selected = object[path]
		}
		if selected == nil {
			selected = object["value"]
		}
		if selected != nil {
			payloadValue, _ := json.Marshal(selected)
			payload = payloadValue
		}
	} else if json.Unmarshal(payload, &envelope) == nil && envelope.Value != nil {
		payloadValue, _ := json.Marshal(envelope.Value)
		payload = payloadValue
	}
	raw := strings.TrimSpace(string(payload))
	if strings.EqualFold(dataType, "Bool") {
		v, err := strconv.ParseBool(strings.Trim(raw, `"`))
		return BoolValue(v), err == nil
	}
	if strings.EqualFold(dataType, "String") {
		return StringValue(strings.Trim(raw, `"`)), true
	}
	v, err := strconv.ParseFloat(strings.Trim(raw, `"`), 64)
	return NumberValue(v), err == nil
}

func valueToJSON(value Value) []byte {
	if value.Number != nil {
		return []byte(strconv.FormatFloat(*value.Number, 'f', -1, 64))
	}
	if value.Bool != nil {
		return []byte(strconv.FormatBool(*value.Bool))
	}
	if value.String != nil {
		encoded, _ := json.Marshal(*value.String)
		return encoded
	}
	return []byte("null")
}
