package acquisition

import (
	"context"
	"fmt"
	"net"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gosnmp/gosnmp"
)

type snmpDriver struct {
	channel   Channel
	tags      []Tag
	publish   func(Sample)
	setStatus func(ChannelStatus)
	mu        sync.Mutex
	client    *gosnmp.GoSNMP
	cancel    context.CancelFunc
	done      chan struct{}
}

func newSNMPDriver(channel Channel, tags []Tag, publish func(Sample), setStatus func(ChannelStatus)) Driver {
	return &snmpDriver{channel: channel, tags: tags, publish: publish, setStatus: setStatus}
}

func (d *snmpDriver) Start(parent context.Context) error {
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

func (d *snmpDriver) Stop(ctx context.Context) error {
	d.mu.Lock()
	cancel, done := d.cancel, d.done
	d.cancel = nil
	if d.client != nil {
		d.client.Conn = nil
	}
	d.client = nil
	d.mu.Unlock()
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

func (d *snmpDriver) Read(ctx context.Context, tags []Tag) ([]Sample, error) {
	d.mu.Lock()
	client, err := d.ensureClientLocked(ctx)
	d.mu.Unlock()
	if err != nil {
		return nil, err
	}
	oids := make([]string, 0, len(tags))
	for _, tag := range tags {
		oids = append(oids, tag.Address)
	}
	result, err := client.Get(oids)
	if err != nil {
		d.mu.Lock()
		if d.client == client {
			_ = client.Conn.Close()
			d.client = nil
		}
		d.mu.Unlock()
		return nil, err
	}
	samples := make([]Sample, 0, len(result.Variables))
	byOID := make(map[string]Tag, len(tags))
	for _, tag := range tags {
		byOID[normalizeSNMPOID(tag.Address)] = tag
	}
	for _, variable := range result.Variables {
		tag, ok := byOID[normalizeSNMPOID(variable.Name)]
		if !ok {
			continue
		}
		value, quality := convertSNMPValue(variable)
		now := time.Now().UnixMilli()
		samples = append(samples, Sample{TagID: tag.ID, Value: value, Quality: quality, SampledAt: now, ReceivedAt: now})
	}
	return samples, nil
}

func normalizeSNMPOID(oid string) string {
	return strings.TrimPrefix(strings.TrimSpace(oid), ".")
}

func (d *snmpDriver) Write(ctx context.Context, tag Tag, value Value) error {
	var pdu gosnmp.SnmpPDU
	switch tag.DataType {
	case "Bool":
		if value.Bool == nil {
			return fmt.Errorf("SNMP Bool write requires bool value")
		}
		pdu = gosnmp.SnmpPDU{Name: tag.Address, Type: gosnmp.Boolean, Value: *value.Bool}
	case "String":
		if value.String == nil {
			return fmt.Errorf("SNMP String write requires string value")
		}
		pdu = gosnmp.SnmpPDU{Name: tag.Address, Type: gosnmp.OctetString, Value: []byte(*value.String)}
	default:
		if value.Number == nil {
			return fmt.Errorf("SNMP numeric write requires numeric value")
		}
		pdu = gosnmp.SnmpPDU{Name: tag.Address, Type: gosnmp.Integer, Value: int(*value.Number)}
	}
	d.mu.Lock()
	client, err := d.ensureClientLocked(ctx)
	d.mu.Unlock()
	if err != nil {
		return err
	}
	if _, err = client.Set([]gosnmp.SnmpPDU{pdu}); err != nil {
		d.mu.Lock()
		if d.client == client {
			_ = client.Conn.Close()
			d.client = nil
		}
		d.mu.Unlock()
	}
	return err
}

func (d *snmpDriver) Test(ctx context.Context, tags []Tag) error {
	if len(tags) == 0 {
		return fmt.Errorf("SNMP test requires at least one tag")
	}
	_, err := d.Read(ctx, tags[:1])
	return err
}

func (d *snmpDriver) loop(ctx context.Context, done chan struct{}) {
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
			d.setStatus(ChannelStatus{ID: d.channel.ID, State: "offline", Detail: err.Error()})
		} else {
			for _, sample := range samples {
				d.publish(sample)
			}
			d.setStatus(ChannelStatus{ID: d.channel.ID, State: "online", Detail: fmt.Sprintf("OK %d OID %dms", len(samples), time.Since(started).Milliseconds())})
		}
		select {
		case <-ctx.Done():
		case <-ticker.C:
		}
	}
}

func (d *snmpDriver) ensureClientLocked(ctx context.Context) (*gosnmp.GoSNMP, error) {
	if d.client != nil {
		return d.client, nil
	}
	params := d.channel.Params
	version := gosnmp.Version2c
	if value, ok := params["snmpVersion"].(string); ok && value == "1" {
		version = gosnmp.Version1
	}
	timeout := time.Duration(snmpNumberParam(params, "timeoutMs", 1500)) * time.Millisecond
	if timeout < 200*time.Millisecond {
		timeout = 200 * time.Millisecond
	}
	retries := snmpNumberParam(params, "retries", 1)
	client := &gosnmp.GoSNMP{Target: d.channel.Host, Port: uint16(d.channel.Port), Community: stringParam(params, "community", "public"), Version: version, Timeout: timeout, Retries: retries, MaxRepetitions: 16}
	if deadline, ok := ctx.Deadline(); ok && time.Until(deadline) <= 0 {
		return nil, ctx.Err()
	}
	if err := client.Connect(); err != nil {
		return nil, fmt.Errorf("SNMP connect %s: %w", net.JoinHostPort(d.channel.Host, strconv.Itoa(d.channel.Port)), err)
	}
	d.client = client
	return client, nil
}

func convertSNMPValue(variable gosnmp.SnmpPDU) (Value, Quality) {
	switch variable.Type {
	case gosnmp.Boolean:
		if value, ok := variable.Value.(bool); ok {
			return BoolValue(value), QualityGood
		}
	case gosnmp.Integer, gosnmp.Counter32, gosnmp.Gauge32, gosnmp.Counter64, gosnmp.TimeTicks:
		if value := gosnmp.ToBigInt(variable.Value); value != nil {
			return NumberValue(float64(value.Int64())), QualityGood
		}
		return NumberValue(float64Value(variable.Value)), QualityGood
	case gosnmp.IPAddress:
		if value, ok := variable.Value.(string); ok {
			return StringValue(value), QualityGood
		}
	case gosnmp.OctetString:
		if bytes, ok := variable.Value.([]byte); ok {
			text := string(bytes)
			if number, err := strconv.ParseFloat(text, 64); err == nil {
				return NumberValue(number), QualityGood
			}
			return StringValue(text), QualityGood
		}
	case gosnmp.Null, gosnmp.NoSuchObject, gosnmp.NoSuchInstance, gosnmp.EndOfMibView:
		return NumberValue(0), QualityUncertain
	}
	return StringValue(fmt.Sprint(variable.Value)), QualityGood
}

func snmpNumberParam(params map[string]any, key string, fallback int) int {
	switch value := params[key].(type) {
	case float64:
		return int(value)
	case int:
		return value
	case int64:
		return int(value)
	default:
		return fallback
	}
}

func float64Value(value any) float64 {
	switch number := value.(type) {
	case int:
		return float64(number)
	case int32:
		return float64(number)
	case uint32:
		return float64(number)
	case uint64:
		return float64(number)
	case float64:
		return number
	default:
		return 0
	}
}
