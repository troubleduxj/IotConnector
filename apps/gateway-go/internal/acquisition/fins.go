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

var finsAddressPattern = regexp.MustCompile(`^(D|W|CIO|H)(\d{1,5})(?:\.(\d{1,2}))?$`)

type finsAddress struct {
	area  byte
	word  uint16
	bit   byte
	isBit bool
}

func parseFINSAddress(address string) (finsAddress, error) {
	matches := finsAddressPattern.FindStringSubmatch(strings.ToUpper(strings.TrimSpace(address)))
	if len(matches) != 4 {
		return finsAddress{}, fmt.Errorf("invalid FINS address %q", address)
	}
	word, err := strconv.ParseUint(matches[2], 10, 16)
	if err != nil {
		return finsAddress{}, fmt.Errorf("invalid FINS address %q: %w", address, err)
	}
	area := map[string]byte{"D": 0x82, "W": 0xB1, "CIO": 0xB0, "H": 0xB2}[matches[1]]
	result := finsAddress{area: area, word: uint16(word)}
	if matches[3] != "" {
		bit, parseErr := strconv.ParseUint(matches[3], 10, 8)
		if parseErr != nil || bit > 15 || matches[1] != "CIO" {
			return finsAddress{}, fmt.Errorf("invalid FINS bit address %q", address)
		}
		result.area, result.bit, result.isBit = 0x30, byte(bit), true
	}
	return result, nil
}

type finsDriver struct {
	channel   Channel
	tags      []Tag
	publish   func(Sample)
	setStatus func(ChannelStatus)
	mu        sync.Mutex
	conn      net.Conn
	cancel    context.CancelFunc
	done      chan struct{}
	sid       byte
}

func newFinsDriver(channel Channel, tags []Tag, publish func(Sample), setStatus func(ChannelStatus)) Driver {
	return &finsDriver{channel: channel, tags: tags, publish: publish, setStatus: setStatus}
}

func (d *finsDriver) Start(parent context.Context) error {
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

func (d *finsDriver) Stop(ctx context.Context) error {
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

func (d *finsDriver) Read(ctx context.Context, tags []Tag) ([]Sample, error) {
	result := make([]Sample, 0, len(tags))
	for _, tag := range tags {
		value, err := d.readTag(ctx, tag)
		if err != nil {
			return nil, fmt.Errorf("FINS read %s: %w", tag.Address, err)
		}
		now := time.Now().UnixMilli()
		result = append(result, Sample{TagID: tag.ID, Value: value, Quality: QualityGood, SampledAt: now, ReceivedAt: now})
	}
	return result, nil
}

func (d *finsDriver) Write(ctx context.Context, tag Tag, value Value) error {
	address, err := parseFINSAddress(tag.Address)
	if err != nil {
		return err
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	if err := d.ensureConnectedLocked(ctx); err != nil {
		return err
	}
	var frame []byte
	if address.isBit {
		if value.Bool == nil {
			return fmt.Errorf("FINS bit write requires bool value")
		}
		frame = finsWriteBit(address, *value.Bool)
	} else {
		if value.Number == nil {
			return fmt.Errorf("FINS numeric write requires numeric value")
		}
		words, err := encodeFINSWords(tag.DataType, *value.Number)
		if err != nil {
			return err
		}
		frame = finsWriteWords(address, words)
	}
	_, err = d.transceiveLocked(ctx, frame)
	if err != nil {
		d.closeLocked()
	}
	return err
}

func (d *finsDriver) Test(ctx context.Context, tags []Tag) error {
	if len(tags) == 0 {
		return fmt.Errorf("FINS test requires at least one tag")
	}
	_, err := d.readTag(ctx, tags[0])
	return err
}

func (d *finsDriver) loop(ctx context.Context, done chan struct{}) {
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

func (d *finsDriver) readTag(ctx context.Context, tag Tag) (Value, error) {
	address, err := parseFINSAddress(tag.Address)
	if err != nil {
		return Value{}, err
	}
	count := uint16(1)
	if tag.DataType == "Float" || tag.DataType == "Int32" {
		count = 2
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	if err := d.ensureConnectedLocked(ctx); err != nil {
		return Value{}, err
	}
	var frame []byte
	if address.isBit {
		frame = finsReadBit(address)
	} else {
		frame = finsReadWords(address, count)
	}
	data, err := d.transceiveLocked(ctx, frame)
	if err != nil {
		d.closeLocked()
		return Value{}, err
	}
	value, err := decodeFINSValue(data, tag.DataType, address.isBit)
	if err != nil {
		return Value{}, fmt.Errorf("FINS response for %s has %d data bytes: %w", tag.Address, len(data), err)
	}
	return value, nil
}

func (d *finsDriver) ensureConnectedLocked(ctx context.Context) error {
	if d.conn != nil {
		return nil
	}
	timeout := 4 * time.Second
	if deadline, ok := ctx.Deadline(); ok && time.Until(deadline) < timeout {
		timeout = time.Until(deadline)
	}
	conn, err := dialCaptured(d.channel.ID, "tcp", net.JoinHostPort(d.channel.Host, strconv.Itoa(d.channel.Port)), timeout)
	if err != nil {
		return fmt.Errorf("FINS connect %s:%d: %w", d.channel.Host, d.channel.Port, err)
	}
	d.conn = conn
	return nil
}

func (d *finsDriver) transceiveLocked(ctx context.Context, frame []byte) ([]byte, error) {
	if d.conn == nil {
		return nil, fmt.Errorf("FINS not connected")
	}
	d.sid++
	if d.sid == 0 {
		d.sid = 1
	}
	// The FINS header starts after the 8-byte TCP command/error prefix.
	// SID is the last byte of that 10-byte header: 8 + 8 + 9 = 25.
	frame[25] = d.sid
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
	header := make([]byte, 8)
	if _, err := io.ReadFull(d.conn, header); err != nil {
		return nil, err
	}
	if string(header[:4]) != "FINS" {
		return nil, fmt.Errorf("invalid FINS/TCP response header")
	}
	length := int(binary.BigEndian.Uint32(header[4:8]))
	if length < 14 || length > 8192 {
		return nil, fmt.Errorf("invalid FINS/TCP response length %d", length)
	}
	body := make([]byte, length)
	if _, err := io.ReadFull(d.conn, body); err != nil {
		return nil, err
	}
	if len(body) < 22 || binary.BigEndian.Uint32(body[4:8]) != 0 || binary.BigEndian.Uint16(body[20:22]) != 0 {
		if len(body) >= 8 && binary.BigEndian.Uint32(body[4:8]) != 0 {
			return nil, fmt.Errorf("FINS/TCP error 0x%08x", binary.BigEndian.Uint32(body[4:8]))
		}
		if len(body) >= 22 {
			return nil, fmt.Errorf("FINS end code 0x%04x", binary.BigEndian.Uint16(body[20:22]))
		}
		return nil, io.ErrUnexpectedEOF
	}
	return body[22:], nil
}

func (d *finsDriver) closeLocked() {
	if d.conn != nil {
		_ = d.conn.Close()
		d.conn = nil
	}
}

func finsWrap(payload []byte) []byte {
	header := make([]byte, 8)
	copy(header[:4], []byte("FINS"))
	binary.BigEndian.PutUint32(header[4:8], uint32(8+len(payload)))
	body := make([]byte, 8, 8+len(payload))
	binary.BigEndian.PutUint32(body[0:4], 0x00000002)
	binary.BigEndian.PutUint32(body[4:8], 0x00000000)
	return append(append(header, body...), payload...)
}

func finsHeader() []byte {
	return []byte{0x80, 0x00, 0x02, 0x00, 0x01, 0x00, 0x00, 0x01, 0x00, 0x00}
}

func finsAddressBytes(address finsAddress) []byte {
	result := make([]byte, 2)
	binary.BigEndian.PutUint16(result, address.word)
	if address.isBit {
		result = append(result, address.bit)
	}
	return result
}

func finsReadWords(address finsAddress, count uint16) []byte {
	payload := append(finsHeader(), 0x01, 0x01, address.area)
	payload = append(payload, finsAddressBytes(address)...)
	countBytes := make([]byte, 2)
	binary.BigEndian.PutUint16(countBytes, count)
	return finsWrap(append(payload, countBytes...))
}

func finsReadBit(address finsAddress) []byte {
	payload := append(finsHeader(), 0x01, 0x01, 0x30)
	payload = append(payload, finsAddressBytes(address)...)
	return finsWrap(append(payload, 0x00, 0x01))
}

func finsWriteWords(address finsAddress, words []uint16) []byte {
	payload := append(finsHeader(), 0x01, 0x02, address.area)
	payload = append(payload, finsAddressBytes(address)...)
	countBytes := make([]byte, 2)
	binary.BigEndian.PutUint16(countBytes, uint16(len(words)))
	payload = append(payload, countBytes...)
	for _, word := range words {
		value := make([]byte, 2)
		binary.BigEndian.PutUint16(value, word)
		payload = append(payload, value...)
	}
	return finsWrap(payload)
}

func finsWriteBit(address finsAddress, value bool) []byte {
	payload := append(finsHeader(), 0x01, 0x02, 0x30)
	payload = append(payload, finsAddressBytes(address)...)
	payload = append(payload, 0x00, 0x01)
	if value {
		payload = append(payload, 0x01)
	} else {
		payload = append(payload, 0x00)
	}
	return finsWrap(payload)
}

func encodeFINSWords(dataType string, value float64) ([]uint16, error) {
	switch dataType {
	case "Float":
		bits := math.Float32bits(float32(value))
		return []uint16{uint16(bits >> 16), uint16(bits)}, nil
	case "Int32":
		bits := uint32(int32(value))
		return []uint16{uint16(bits >> 16), uint16(bits)}, nil
	case "Double":
		return nil, fmt.Errorf("FINS Double writes are not supported")
	default:
		return []uint16{uint16(int16(value))}, nil
	}
}

func decodeFINSValue(data []byte, dataType string, isBit bool) (Value, error) {
	if isBit || dataType == "Bool" {
		if len(data) < 1 {
			return Value{}, io.ErrUnexpectedEOF
		}
		return BoolValue(data[0] != 0), nil
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
