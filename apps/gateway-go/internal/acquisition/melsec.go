package acquisition

import (
	"context"
	"encoding/binary"
	"fmt"
	"io"
	"math"
	"net"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

var mcAddressPattern = regexp.MustCompile(`^(ZR|[DWRMBXY])(\d+)$`)

var mcDeviceCodes = map[string]byte{
	"D": 0xA8, "W": 0xB4, "R": 0xAF, "M": 0x90,
	"X": 0x9C, "Y": 0x9D, "B": 0xA0, "ZR": 0xB0,
}

var mcBitDevices = map[string]bool{"M": true, "X": true, "Y": true, "B": true}

type mcAddress struct {
	device string
	number uint32
}

func parseMCAddress(address string) (mcAddress, error) {
	matches := mcAddressPattern.FindStringSubmatch(strings.ToUpper(strings.TrimSpace(address)))
	if len(matches) != 3 {
		return mcAddress{}, fmt.Errorf("invalid MELSEC address %q", address)
	}
	number, err := strconv.ParseUint(matches[2], 10, 24)
	if err != nil {
		return mcAddress{}, fmt.Errorf("invalid MELSEC address %q: %w", address, err)
	}
	return mcAddress{device: matches[1], number: uint32(number)}, nil
}

type melsecDriver struct {
	channel   Channel
	tags      []Tag
	publish   func(Sample)
	setStatus func(ChannelStatus)
	mu        sync.Mutex
	conn      net.Conn
	cancel    context.CancelFunc
	done      chan struct{}
}

func newMelsecDriver(channel Channel, tags []Tag, publish func(Sample), setStatus func(ChannelStatus)) Driver {
	return &melsecDriver{channel: channel, tags: tags, publish: publish, setStatus: setStatus}
}

func (d *melsecDriver) Start(parent context.Context) error {
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

func (d *melsecDriver) Stop(ctx context.Context) error {
	d.mu.Lock()
	cancel, done := d.cancel, d.done
	d.cancel = nil
	d.closeLocked()
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

func (d *melsecDriver) Read(ctx context.Context, tags []Tag) ([]Sample, error) {
	result := make([]Sample, 0, len(tags))
	for _, tag := range tags {
		value, err := d.readTag(ctx, tag)
		if err != nil {
			return nil, err
		}
		now := time.Now().UnixMilli()
		result = append(result, Sample{TagID: tag.ID, Value: value, Quality: QualityGood, SampledAt: now, ReceivedAt: now})
	}
	return result, nil
}

func (d *melsecDriver) Write(ctx context.Context, tag Tag, value Value) error {
	address, err := parseMCAddress(tag.Address)
	if err != nil {
		return err
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	if err := d.ensureConnectedLocked(ctx); err != nil {
		return err
	}
	var frame []byte
	if tag.DataType == "Bool" {
		if value.Bool == nil {
			return fmt.Errorf("MELSEC bool write requires bool value")
		}
		frame = mcWriteBits(address, []bool{*value.Bool})
	} else {
		if value.Number == nil {
			return fmt.Errorf("MELSEC numeric write requires numeric value")
		}
		words, err := encodeMCWords(tag.DataType, *value.Number)
		if err != nil {
			return err
		}
		frame = mcWriteWords(address, words)
	}
	_, err = d.transceiveLocked(ctx, frame)
	if err != nil {
		d.closeLocked()
	}
	return err
}

func (d *melsecDriver) Test(ctx context.Context, tags []Tag) error {
	if len(tags) == 0 {
		return fmt.Errorf("MELSEC test requires at least one tag")
	}
	_, err := d.readTag(ctx, tags[0])
	return err
}

func (d *melsecDriver) loop(ctx context.Context, done chan struct{}) {
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
			d.setStatus(ChannelStatus{ID: d.channel.ID, State: "online", Detail: fmt.Sprintf("OK %dms", time.Since(started).Milliseconds())})
		}
		select {
		case <-ctx.Done():
		case <-ticker.C:
		}
	}
}

func (d *melsecDriver) readTag(ctx context.Context, tag Tag) (Value, error) {
	address, err := parseMCAddress(tag.Address)
	if err != nil {
		return Value{}, err
	}
	count := uint16(1)
	if tag.DataType == "Float" || tag.DataType == "Double" || tag.DataType == "Int32" {
		count = 2
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	if err := d.ensureConnectedLocked(ctx); err != nil {
		return Value{}, err
	}
	var data []byte
	if mcBitDevices[address.device] {
		data, err = d.transceiveLocked(ctx, mcReadBits(address, 1))
	} else {
		data, err = d.transceiveLocked(ctx, mcReadWords(address, count))
	}
	if err != nil {
		d.closeLocked()
		return Value{}, err
	}
	return decodeMCValue(data, tag.DataType)
}

func (d *melsecDriver) ensureConnectedLocked(ctx context.Context) error {
	if d.conn != nil {
		return nil
	}
	timeout := 4 * time.Second
	if deadline, ok := ctx.Deadline(); ok && time.Until(deadline) < timeout {
		timeout = time.Until(deadline)
	}
	conn, err := dialCaptured(d.channel.ID, "tcp", net.JoinHostPort(d.channel.Host, strconv.Itoa(d.channel.Port)), timeout)
	if err != nil {
		return fmt.Errorf("MELSEC connect %s:%d: %w", d.channel.Host, d.channel.Port, err)
	}
	d.conn = conn
	return nil
}

func (d *melsecDriver) transceiveLocked(ctx context.Context, frame []byte) ([]byte, error) {
	if d.conn == nil {
		return nil, fmt.Errorf("MELSEC not connected")
	}
	deadline := time.Now().Add(4 * time.Second)
	if ctxDeadline, ok := ctx.Deadline(); ok && ctxDeadline.Before(deadline) {
		deadline = ctxDeadline
	}
	if err := d.conn.SetDeadline(deadline); err != nil {
		return nil, err
	}
	if _, err := d.conn.Write(frame); err != nil {
		return nil, err
	}
	header := make([]byte, 9)
	if _, err := io.ReadFull(d.conn, header); err != nil {
		return nil, err
	}
	length := int(binary.LittleEndian.Uint16(header[7:9]))
	if length < 2 || length > 8192 {
		return nil, fmt.Errorf("invalid MELSEC response length %d", length)
	}
	body := make([]byte, length)
	if _, err := io.ReadFull(d.conn, body); err != nil {
		return nil, err
	}
	if len(body) < 2 || binary.LittleEndian.Uint16(body[:2]) != 0 {
		return nil, fmt.Errorf("MELSEC end code 0x%04x", binary.LittleEndian.Uint16(body[:2]))
	}
	return body[2:], nil
}

func (d *melsecDriver) closeLocked() {
	if d.conn != nil {
		_ = d.conn.Close()
		d.conn = nil
	}
}

func mcHeader(dataLen int) []byte {
	header := make([]byte, 9)
	binary.LittleEndian.PutUint16(header[0:2], 0x0050)
	header[3] = 0xFF
	header[4], header[5] = 0xFF, 0x03
	binary.LittleEndian.PutUint16(header[7:9], uint16(dataLen))
	return header
}

func mcReadWords(address mcAddress, count uint16) []byte {
	body := make([]byte, 12)
	binary.LittleEndian.PutUint16(body[0:2], 0x0010)
	binary.LittleEndian.PutUint16(body[2:4], 0x0401)
	body[6] = mcDeviceCodes[address.device]
	body[7] = byte(address.number)
	body[8] = byte(address.number >> 8)
	body[9] = byte(address.number >> 16)
	binary.LittleEndian.PutUint16(body[10:12], count)
	return append(mcHeader(len(body)), body...)
}

func mcReadBits(address mcAddress, count uint16) []byte {
	body := mcReadWords(address, count)[9:]
	binary.LittleEndian.PutUint16(body[4:6], 0x0001)
	return append(mcHeader(len(body)), body...)
}

func mcWriteWords(address mcAddress, words []uint16) []byte {
	body := make([]byte, 12+len(words)*2)
	binary.LittleEndian.PutUint16(body[0:2], 0x0010)
	binary.LittleEndian.PutUint16(body[2:4], 0x1401)
	body[6] = mcDeviceCodes[address.device]
	body[7] = byte(address.number)
	body[8] = byte(address.number >> 8)
	body[9] = byte(address.number >> 16)
	binary.LittleEndian.PutUint16(body[10:12], uint16(len(words)))
	for i, word := range words {
		binary.BigEndian.PutUint16(body[12+i*2:], word)
	}
	return append(mcHeader(len(body)), body...)
}

func mcWriteBits(address mcAddress, values []bool) []byte {
	body := make([]byte, 12+len(values))
	binary.LittleEndian.PutUint16(body[0:2], 0x0010)
	binary.LittleEndian.PutUint16(body[2:4], 0x1401)
	binary.LittleEndian.PutUint16(body[4:6], 0x0001)
	body[6] = mcDeviceCodes[address.device]
	body[7] = byte(address.number)
	body[8] = byte(address.number >> 8)
	body[9] = byte(address.number >> 16)
	binary.LittleEndian.PutUint16(body[10:12], uint16(len(values)))
	for i, value := range values {
		if value {
			body[12+i] = 0x10
		}
	}
	return append(mcHeader(len(body)), body...)
}

func encodeMCWords(dataType string, value float64) ([]uint16, error) {
	switch dataType {
	case "Float":
		bits := math.Float32bits(float32(value))
		return []uint16{uint16(bits >> 16), uint16(bits)}, nil
	case "Int32":
		bits := uint32(int32(value))
		return []uint16{uint16(bits >> 16), uint16(bits)}, nil
	case "Double":
		return nil, fmt.Errorf("MELSEC Double writes are not supported")
	default:
		return []uint16{uint16(int16(value))}, nil
	}
}

func decodeMCValue(data []byte, dataType string) (Value, error) {
	if dataType == "Bool" {
		if len(data) < 1 {
			return Value{}, io.ErrUnexpectedEOF
		}
		return BoolValue(data[0]&0x01 != 0), nil
	}
	if len(data) < 2 {
		return Value{}, io.ErrUnexpectedEOF
	}
	if dataType == "Float" || dataType == "Int32" {
		if len(data) < 4 {
			return Value{}, io.ErrUnexpectedEOF
		}
		bits := binary.BigEndian.Uint32(data)
		if dataType == "Float" {
			return NumberValue(float64(math.Float32frombits(bits))), nil
		}
		return NumberValue(float64(int32(bits))), nil
	}
	word := binary.BigEndian.Uint16(data)
	if dataType == "UInt16" {
		return NumberValue(float64(word)), nil
	}
	return NumberValue(float64(int16(word))), nil
}
