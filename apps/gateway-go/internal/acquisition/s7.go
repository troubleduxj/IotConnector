package acquisition

import (
	"context"
	"fmt"
	"net"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/robinson/gos7"
)

var s7AddressPattern = regexp.MustCompile(`^DB(\d+)\.(DBX(\d+)\.(\d+)|((?:REAL|DINT|INT|WORD|DWORD|DBW|DBD|DBB|BYTE|CHAR))(\d+))$`)
var s7AreaAddressPattern = regexp.MustCompile(`^([MIEQACZT])([BWD]?)(\d+)(?:\.(\d+))?$`)

type s7Address struct {
	area string
	db   int
	off  int
	bit  uint
	kind string
}

func parseS7Address(address string) (s7Address, error) {
	text := strings.ToUpper(strings.TrimSpace(address))
	matches := s7AddressPattern.FindStringSubmatch(text)
	if len(matches) == 7 {
		db, err := strconv.Atoi(matches[1])
		if err != nil {
			return s7Address{}, err
		}
		if matches[2] != "" && strings.HasPrefix(matches[2], "DBX") {
			off, _ := strconv.Atoi(matches[3])
			bit, _ := strconv.Atoi(matches[4])
			if bit > 7 {
				return s7Address{}, fmt.Errorf("invalid S7 bit %q", address)
			}
			return s7Address{area: "DB", db: db, off: off, bit: uint(bit), kind: "Bool"}, nil
		}
		off, _ := strconv.Atoi(matches[6])
		kind := matches[5]
		switch kind {
		case "REAL":
			kind = "Float"
		case "DINT", "DBD", "DWORD":
			kind = "Int32"
		case "INT", "DBW":
			kind = "Int16"
		case "WORD":
			kind = "UInt16"
		case "DBB", "BYTE", "CHAR":
			kind = "Byte"
		default:
			return s7Address{}, fmt.Errorf("unsupported S7 address type %q", address)
		}
		return s7Address{area: "DB", db: db, off: off, kind: kind}, nil
	}

	areaMatches := s7AreaAddressPattern.FindStringSubmatch(text)
	if len(areaMatches) != 5 {
		return s7Address{}, fmt.Errorf("invalid S7 DB address %q", address)
	}
	off, err := strconv.Atoi(areaMatches[3])
	if err != nil {
		return s7Address{}, err
	}
	area := areaMatches[1]
	if area == "E" {
		area = "I"
	} else if area == "A" {
		area = "Q"
	} else if area == "Z" {
		area = "C"
	}
	kind := "Byte"
	bit := uint(0)
	if areaMatches[4] != "" {
		bitValue, _ := strconv.Atoi(areaMatches[4])
		if bitValue > 7 {
			return s7Address{}, fmt.Errorf("invalid S7 bit %q", address)
		}
		bit = uint(bitValue)
		kind = "Bool"
	} else {
		switch areaMatches[2] {
		case "W":
			kind = "Int16"
		case "D":
			kind = "Int32"
		case "B", "":
			kind = "Byte"
		}
		if area == "T" || area == "C" {
			kind = "UInt16"
		}
	}
	return s7Address{area: area, off: off, bit: bit, kind: kind}, nil
}

type s7Driver struct {
	channel   Channel
	tags      []Tag
	publish   func(Sample)
	setStatus func(ChannelStatus)
	mu        sync.Mutex
	handler   *gos7.TCPClientHandler
	client    gos7.Client
	cancel    context.CancelFunc
	done      chan struct{}
}

func newS7Driver(channel Channel, tags []Tag, publish func(Sample), setStatus func(ChannelStatus)) Driver {
	return &s7Driver{channel: channel, tags: tags, publish: publish, setStatus: setStatus}
}

func (d *s7Driver) Start(parent context.Context) error {
	d.mu.Lock()
	if d.cancel != nil {
		d.mu.Unlock()
		return nil
	}
	ctx, cancel := context.WithCancel(parent)
	d.cancel, d.done = cancel, make(chan struct{})
	d.mu.Unlock()
	go d.loop(ctx, d.done)
	return nil
}

func (d *s7Driver) Stop(ctx context.Context) error {
	d.mu.Lock()
	cancel, done, handler := d.cancel, d.done, d.handler
	d.cancel, d.client, d.handler = nil, nil, nil
	d.mu.Unlock()
	if handler != nil {
		_ = handler.Close()
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

func (d *s7Driver) Read(ctx context.Context, tags []Tag) ([]Sample, error) {
	d.mu.Lock()
	client, err := d.ensureClientLocked(ctx)
	d.mu.Unlock()
	if err != nil {
		return nil, err
	}
	result, err := d.readTags(client, tags)
	if err != nil {
		d.resetClient()
		return nil, err
	}
	return result, nil
}

func (d *s7Driver) readTags(client gos7.Client, tags []Tag) ([]Sample, error) {
	if len(tags) <= 1 {
		result := make([]Sample, 0, len(tags))
		for _, tag := range tags {
			value, err := d.readTag(client, tag)
			if err != nil {
				return nil, err
			}
			now := time.Now().UnixMilli()
			result = append(result, Sample{TagID: tag.ID, Value: value, Quality: QualityGood, SampledAt: now, ReceivedAt: now})
		}
		return result, nil
	}
	result := make([]Sample, 0, len(tags))
	for start := 0; start < len(tags); start += 20 {
		end := start + 20
		if end > len(tags) {
			end = len(tags)
		}
		batch, err := d.readTagBatch(client, tags[start:end])
		if err != nil {
			// Some older CPUs and simulators do not implement Read Var. Preserve
			// compatibility by retrying this batch with individual reads.
			batch = make([]Sample, 0, end-start)
			for _, tag := range tags[start:end] {
				value, readErr := d.readTag(client, tag)
				if readErr != nil {
					return nil, readErr
				}
				now := time.Now().UnixMilli()
				batch = append(batch, Sample{TagID: tag.ID, Value: value, Quality: QualityGood, SampledAt: now, ReceivedAt: now})
			}
		}
		result = append(result, batch...)
	}
	return result, nil
}

func (d *s7Driver) readTagBatch(client gos7.Client, tags []Tag) ([]Sample, error) {
	items := make([]gos7.S7DataItem, len(tags))
	addresses := make([]s7Address, len(tags))
	for i, tag := range tags {
		address, err := parseS7Address(tag.Address)
		if err != nil {
			return nil, err
		}
		addresses[i] = address
		wordLen, area, ok := s7MultiMapping(address)
		if !ok {
			return nil, fmt.Errorf("S7 address %q cannot be batched", tag.Address)
		}
		items[i] = gos7.S7DataItem{Area: area, WordLen: wordLen, DBNumber: address.db, Start: address.off, Bit: int(address.bit), Amount: 1, Data: make([]byte, s7ValueSize(address.kind))}
	}
	if err := client.AGReadMulti(items, len(items)); err != nil {
		return nil, err
	}
	result := make([]Sample, len(tags))
	for i, tag := range tags {
		if items[i].Error != "" {
			return nil, fmt.Errorf("S7 read %s: %s", tag.Address, items[i].Error)
		}
		value, err := decodeS7Value(addresses[i], items[i].Data)
		if err != nil {
			return nil, err
		}
		now := time.Now().UnixMilli()
		result[i] = Sample{TagID: tag.ID, Value: value, Quality: QualityGood, SampledAt: now, ReceivedAt: now}
	}
	return result, nil
}

func s7MultiMapping(address s7Address) (wordLen, area int, ok bool) {
	switch address.area {
	case "DB":
		area = 0x84
	case "M":
		area = 0x83
	case "I":
		area = 0x81
	case "Q":
		area = 0x82
	case "T":
		area = 0x1D
	case "C":
		area = 0x1C
	default:
		return 0, 0, false
	}
	switch {
	case address.kind == "Bool":
		return 0x01, area, true
	case address.area == "T":
		return 0x1D, area, true
	case address.area == "C":
		return 0x1C, area, true
	case address.kind == "Byte":
		return 0x02, area, true
	case address.kind == "Int16" || address.kind == "UInt16":
		return 0x04, area, true
	case address.kind == "Int32":
		return 0x07, area, true
	case address.kind == "Float":
		return 0x08, area, true
	default:
		return 0, 0, false
	}
}

func (d *s7Driver) Write(ctx context.Context, tag Tag, value Value) error {
	address, err := parseS7Address(tag.Address)
	if err != nil {
		return err
	}
	d.mu.Lock()
	client, err := d.ensureClientLocked(ctx)
	d.mu.Unlock()
	if err != nil {
		return err
	}
	size := s7ValueSize(address.kind)
	buffer := make([]byte, size)
	helper := gos7.Helper{}
	switch address.kind {
	case "Bool":
		if value.Bool == nil {
			return fmt.Errorf("S7 Bool write requires bool value")
		}
		// A bit write must preserve the other seven bits in the same byte.
		if err := readS7Area(client, address, buffer); err != nil {
			d.resetClient()
			return err
		}
		buffer[0] = helper.SetBoolAt(buffer[0], address.bit, *value.Bool)
	case "Float":
		if value.Number == nil {
			return fmt.Errorf("S7 Float write requires numeric value")
		}
		helper.SetRealAt(buffer, 0, float32(*value.Number))
	case "Int32":
		if value.Number == nil {
			return fmt.Errorf("S7 Int32 write requires numeric value")
		}
		helper.SetValueAt(buffer, 0, int32(*value.Number))
	case "UInt16":
		if value.Number == nil {
			return fmt.Errorf("S7 UInt16 write requires numeric value")
		}
		helper.SetValueAt(buffer, 0, uint16(*value.Number))
	default:
		if value.Number == nil {
			return fmt.Errorf("S7 numeric write requires numeric value")
		}
		helper.SetValueAt(buffer, 0, int16(*value.Number))
	}
	if err := writeS7Area(client, address, buffer); err != nil {
		d.resetClient()
		return err
	}
	return nil
}

func (d *s7Driver) Test(ctx context.Context, tags []Tag) error {
	if len(tags) == 0 {
		return fmt.Errorf("S7 test requires at least one tag")
	}
	_, err := d.Read(ctx, tags[:1])
	return err
}

func (d *s7Driver) loop(ctx context.Context, done chan struct{}) {
	defer close(done)
	interval := time.Duration(d.channel.PollIntervalMs) * time.Millisecond
	if interval < 300*time.Millisecond {
		interval = 300 * time.Millisecond
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
			d.setStatus(ChannelStatus{ID: d.channel.ID, State: "online", Detail: fmt.Sprintf("OK %dms", time.Since(started).Milliseconds())})
		}
		select {
		case <-ctx.Done():
		case <-ticker.C:
		}
	}
}

func (d *s7Driver) ensureClientLocked(ctx context.Context) (gos7.Client, error) {
	if d.client != nil {
		return d.client, nil
	}
	rack, slot := s7IntParam(d.channel.Params, "rack", 0), s7IntParam(d.channel.Params, "slot", 1)
	address := net.JoinHostPort(d.channel.Host, strconv.Itoa(d.channel.Port))
	handler := gos7.NewTCPClientHandler(address, rack, slot)
	if err := handler.ConnectContext(ctx); err != nil {
		return nil, fmt.Errorf("S7 connect %s rack=%d slot=%d: %w", address, rack, slot, err)
	}
	d.handler, d.client = handler, gos7.NewClient(handler)
	return d.client, nil
}

func (d *s7Driver) resetClient() {
	d.mu.Lock()
	handler := d.handler
	d.handler, d.client = nil, nil
	d.mu.Unlock()
	if handler != nil {
		_ = handler.Close()
	}
}

func (d *s7Driver) readTag(client gos7.Client, tag Tag) (Value, error) {
	address, err := parseS7Address(tag.Address)
	if err != nil {
		return Value{}, err
	}
	size := s7ValueSize(address.kind)
	buffer := make([]byte, size)
	if err := readS7Area(client, address, buffer); err != nil {
		return Value{}, err
	}
	return decodeS7Value(address, buffer)
}

func decodeS7Value(address s7Address, buffer []byte) (Value, error) {
	helper := gos7.Helper{}
	if len(buffer) < s7ValueSize(address.kind) {
		return Value{}, fmt.Errorf("S7 %s returned %d bytes, need %d", address.kind, len(buffer), s7ValueSize(address.kind))
	}
	switch address.kind {
	case "Bool":
		return BoolValue(helper.GetBoolAt(buffer[0], address.bit)), nil
	case "Float":
		return NumberValue(float64(helper.GetRealAt(buffer, 0))), nil
	case "Int32":
		var value int32
		helper.GetValueAt(buffer, 0, &value)
		return NumberValue(float64(value)), nil
	case "UInt16":
		var value uint16
		helper.GetValueAt(buffer, 0, &value)
		return NumberValue(float64(value)), nil
	case "Byte":
		return NumberValue(float64(buffer[0])), nil
	default:
		var value int16
		helper.GetValueAt(buffer, 0, &value)
		return NumberValue(float64(value)), nil
	}
}

func readS7Area(client gos7.Client, address s7Address, buffer []byte) error {
	switch address.area {
	case "DB":
		return client.AGReadDB(address.db, address.off, len(buffer), buffer)
	case "M":
		return client.AGReadMB(address.off, len(buffer), buffer)
	case "I":
		return client.AGReadEB(address.off, len(buffer), buffer)
	case "Q":
		return client.AGReadAB(address.off, len(buffer), buffer)
	case "T":
		return client.AGReadTM(address.off, len(buffer), buffer)
	case "C":
		return client.AGReadCT(address.off, len(buffer), buffer)
	default:
		return fmt.Errorf("unsupported S7 area %q", address.area)
	}
}

func writeS7Area(client gos7.Client, address s7Address, buffer []byte) error {
	switch address.area {
	case "DB":
		return client.AGWriteDB(address.db, address.off, len(buffer), buffer)
	case "M":
		return client.AGWriteMB(address.off, len(buffer), buffer)
	case "I":
		return client.AGWriteEB(address.off, len(buffer), buffer)
	case "Q":
		return client.AGWriteAB(address.off, len(buffer), buffer)
	case "T":
		return client.AGWriteTM(address.off, len(buffer), buffer)
	case "C":
		return client.AGWriteCT(address.off, len(buffer), buffer)
	default:
		return fmt.Errorf("unsupported S7 area %q", address.area)
	}
}

func s7ValueSize(kind string) int {
	switch kind {
	case "Bool", "Byte":
		return 1
	case "Float", "Int32":
		return 4
	default:
		return 2
	}
}

func s7IntParam(params map[string]any, key string, fallback int) int {
	switch value := params[key].(type) {
	case float64:
		return int(value)
	case int:
		return value
	default:
		return fallback
	}
}
