package acquisition

import (
	"context"
	"encoding/binary"
	"fmt"
	"io"
	"math"
	"net"
	"strconv"
	"sync"
	"time"
)

var cipTypes = map[string]uint16{"Bool": 0xC1, "Int16": 0xC3, "UInt16": 0xC3, "Int32": 0xC4, "Float": 0xCA}

type enipDriver struct {
	channel   Channel
	tags      []Tag
	publish   func(Sample)
	setStatus func(ChannelStatus)
	mu        sync.Mutex
	conn      net.Conn
	session   uint32
	cancel    context.CancelFunc
	done      chan struct{}
	sequence  uint32
}

func newEnipDriver(channel Channel, tags []Tag, publish func(Sample), setStatus func(ChannelStatus)) Driver {
	return &enipDriver{channel: channel, tags: tags, publish: publish, setStatus: setStatus}
}

func (d *enipDriver) Start(parent context.Context) error {
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

func (d *enipDriver) Stop(ctx context.Context) error {
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

func (d *enipDriver) Read(ctx context.Context, tags []Tag) ([]Sample, error) {
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

func (d *enipDriver) Write(ctx context.Context, tag Tag, value Value) error {
	typeCode, ok := cipTypes[tag.DataType]
	if !ok {
		return fmt.Errorf("unsupported EtherNet/IP data type %s", tag.DataType)
	}
	data, err := encodeCIPValue(tag.DataType, value)
	if err != nil {
		return err
	}
	ioi := cipSymbolicPath(tag.Address)
	embedded := make([]byte, 0, 6+len(ioi)+len(data))
	embedded = append(embedded, 0x4D, byte(len(ioi)/2))
	embedded = append(embedded, ioi...)
	typeBytes := make([]byte, 2)
	binary.LittleEndian.PutUint16(typeBytes, typeCode)
	embedded = append(embedded, typeBytes...)
	embedded = append(embedded, data...)
	d.mu.Lock()
	defer d.mu.Unlock()
	if err := d.ensureSessionLocked(ctx); err != nil {
		return err
	}
	response, err := d.roundTripLocked(ctx, enipUnconnected(d.session, embedded, d.slot()))
	if err != nil {
		d.closeLocked()
		return err
	}
	if err := parseCIPResponseStatus(response); err != nil {
		d.closeLocked()
		return err
	}
	return nil
}

func (d *enipDriver) Test(ctx context.Context, tags []Tag) error {
	if len(tags) == 0 {
		return fmt.Errorf("EtherNet/IP test requires at least one tag")
	}
	_, err := d.readTag(ctx, tags[0])
	return err
}

func (d *enipDriver) loop(ctx context.Context, done chan struct{}) {
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

func (d *enipDriver) readTag(ctx context.Context, tag Tag) (Value, error) {
	ioi := cipSymbolicPath(tag.Address)
	embedded := append([]byte{0x4C, byte(len(ioi) / 2)}, ioi...)
	d.mu.Lock()
	defer d.mu.Unlock()
	if err := d.ensureSessionLocked(ctx); err != nil {
		return Value{}, err
	}
	response, err := d.roundTripLocked(ctx, enipUnconnected(d.session, embedded, d.slot()))
	if err != nil {
		d.closeLocked()
		return Value{}, err
	}
	data, typeCode, err := parseCIPReadResponse(response)
	if err != nil {
		d.closeLocked()
		return Value{}, err
	}
	return decodeCIPValue(data, typeCode, tag.DataType)
}

func (d *enipDriver) ensureSessionLocked(ctx context.Context) error {
	if d.conn != nil && d.session != 0 {
		return nil
	}
	timeout := 4 * time.Second
	if deadline, ok := ctx.Deadline(); ok && time.Until(deadline) < timeout {
		timeout = time.Until(deadline)
	}
	conn, err := net.DialTimeout("tcp", net.JoinHostPort(d.channel.Host, strconv.Itoa(d.channel.Port)), timeout)
	if err != nil {
		return fmt.Errorf("EtherNet/IP connect %s:%d: %w", d.channel.Host, d.channel.Port, err)
	}
	d.conn = conn
	body := make([]byte, 4)
	binary.LittleEndian.PutUint16(body, 1)
	response, err := d.roundTripLocked(ctx, enipEncap(0x0065, 0, body))
	if err != nil {
		d.closeLocked()
		return err
	}
	if len(response) < 8 {
		d.closeLocked()
		return io.ErrUnexpectedEOF
	}
	d.session = binary.LittleEndian.Uint32(response[4:8])
	if d.session == 0 {
		d.closeLocked()
		return fmt.Errorf("EtherNet/IP returned empty session")
	}
	return nil
}

func (d *enipDriver) roundTripLocked(ctx context.Context, frame []byte) ([]byte, error) {
	if d.conn == nil {
		return nil, fmt.Errorf("EtherNet/IP not connected")
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
	header := make([]byte, 24)
	if _, err := io.ReadFull(d.conn, header); err != nil {
		return nil, err
	}
	length := int(binary.LittleEndian.Uint16(header[2:4]))
	if length < 0 || length > 65535 {
		return nil, fmt.Errorf("invalid EtherNet/IP frame length %d", length)
	}
	body := make([]byte, length)
	if _, err := io.ReadFull(d.conn, body); err != nil {
		return nil, err
	}
	response := append(header, body...)
	if status := binary.LittleEndian.Uint32(response[8:12]); status != 0 {
		return nil, fmt.Errorf("EtherNet/IP encapsulation status 0x%08x", status)
	}
	return response, nil
}

func (d *enipDriver) closeLocked() {
	if d.conn != nil {
		_ = d.conn.Close()
		d.conn = nil
	}
	d.session = 0
}

func (d *enipDriver) slot() byte {
	if value, ok := d.channel.Params["slot"].(float64); ok && value >= 0 && value <= 255 {
		return byte(value)
	}
	if value, ok := d.channel.Params["slot"].(int); ok && value >= 0 && value <= 255 {
		return byte(value)
	}
	// Keep the implicit route aligned with the Node driver and the
	// ProtoForge ControlLogix endpoint. An explicit channel parameter still
	// overrides this default for real devices with a different chassis slot.
	return 1
}

func enipEncap(command uint16, session uint32, body []byte) []byte {
	header := make([]byte, 24)
	binary.LittleEndian.PutUint16(header[0:2], command)
	binary.LittleEndian.PutUint16(header[2:4], uint16(len(body)))
	binary.LittleEndian.PutUint32(header[4:8], session)
	return append(header, body...)
}

func cipSymbolicPath(name string) []byte {
	bytes := []byte(name)
	path := append([]byte{0x91, byte(len(bytes))}, bytes...)
	if len(bytes)%2 != 0 {
		path = append(path, 0)
	}
	return path
}

func enipUnconnected(session uint32, embedded []byte, slot byte) []byte {
	route := []byte{0x01, 0x00, 0x20, 0x02, 0x24, slot}
	// The simulator and common UCMM devices expect the embedded CIP service
	// directly here; do not wrap an already formed 0x4C/0x4D Tag service.
	rr := append([]byte{}, embedded...)
	rr = append(rr, route...)
	if len(rr)%2 != 0 {
		rr = append(rr, 0)
	}
	body := make([]byte, 6)
	items := []byte{0x02, 0x00}
	addrItem := []byte{0xA1, 0x00, 0x04, 0x00, 0, 0, 0, 0}
	// SendRRData requests carry the CIP payload in an Unconnected Data item.
	dataItem := []byte{0xB2, 0x00, byte(len(rr)), byte(len(rr) >> 8)}
	body = append(body, items...)
	body = append(body, addrItem...)
	body = append(body, dataItem...)
	body = append(body, rr...)
	return enipEncap(0x006F, session, body)
}

func parseCIPReadResponse(frame []byte) ([]byte, uint16, error) {
	rr, err := extractCIPResponseData(frame)
	if err != nil {
		return nil, 0, err
	}
	if len(rr) < 7 {
		return nil, 0, io.ErrUnexpectedEOF
	}
	typeCode := uint16(rr[4])
	size := int(binary.LittleEndian.Uint16(rr[5:7]))
	if size < 1 || 7+size > len(rr) {
		return nil, 0, io.ErrUnexpectedEOF
	}
	if typeCode == 0xC1 {
		size = 1
	}
	return rr[7 : 7+size], typeCode, nil
}

func parseCIPResponseStatus(frame []byte) error {
	rr, err := extractCIPResponseData(frame)
	if err != nil {
		return err
	}
	if len(rr) < 4 {
		return io.ErrUnexpectedEOF
	}
	if rr[2] != 0 {
		return fmt.Errorf("CIP response status 0x%02x", rr[2])
	}
	return nil
}

func extractCIPResponseData(frame []byte) ([]byte, error) {
	if len(frame) < 32 {
		return nil, io.ErrUnexpectedEOF
	}
	base := 24
	if binary.LittleEndian.Uint16(frame[base+6:base+8]) != 2 {
		return nil, fmt.Errorf("unexpected EtherNet/IP item count")
	}
	p := base + 8
	addrLength := int(binary.LittleEndian.Uint16(frame[p+2 : p+4]))
	p += 4 + addrLength
	if p+4 > len(frame) {
		return nil, fmt.Errorf("missing EtherNet/IP data item")
	}
	itemType := binary.LittleEndian.Uint16(frame[p : p+2])
	if itemType != 0x00B1 && itemType != 0x00B2 {
		return nil, fmt.Errorf("missing EtherNet/IP data item")
	}
	dataLength := int(binary.LittleEndian.Uint16(frame[p+2 : p+4]))
	p += 4
	if p+dataLength > len(frame) || dataLength < 4 {
		return nil, io.ErrUnexpectedEOF
	}
	rr := frame[p : p+dataLength]
	if len(rr) < 4 || (rr[0] != 0xCC && rr[0] != 0xCD) || rr[1] != 0 || rr[2] != 0 || rr[3] != 0 {
		return nil, fmt.Errorf("CIP response status 0x%02x", func() byte {
			if len(rr) > 2 {
				return rr[2]
			}
			return 0xFF
		}())
	}
	return rr, nil
}

func encodeCIPValue(dataType string, value Value) ([]byte, error) {
	result := make([]byte, 0, 4)
	switch dataType {
	case "Bool":
		if value.Bool == nil {
			return nil, fmt.Errorf("Bool write requires bool value")
		}
		if *value.Bool {
			return []byte{1}, nil
		}
		return []byte{0}, nil
	case "Float":
		if value.Number == nil {
			return nil, fmt.Errorf("Float write requires numeric value")
		}
		result = make([]byte, 4)
		binary.LittleEndian.PutUint32(result, math.Float32bits(float32(*value.Number)))
		return result, nil
	case "Int32":
		if value.Number == nil {
			return nil, fmt.Errorf("Int32 write requires numeric value")
		}
		result = make([]byte, 4)
		binary.LittleEndian.PutUint32(result, uint32(int32(*value.Number)))
		return result, nil
	default:
		if value.Number == nil {
			return nil, fmt.Errorf("numeric write requires numeric value")
		}
		result = make([]byte, 2)
		binary.LittleEndian.PutUint16(result, uint16(*value.Number))
		return result, nil
	}
}

func decodeCIPValue(data []byte, typeCode uint16, dataType string) (Value, error) {
	if dataType == "Bool" || typeCode == 0xC1 {
		if len(data) < 1 {
			return Value{}, io.ErrUnexpectedEOF
		}
		return BoolValue(data[0] != 0), nil
	}
	if dataType == "Float" || typeCode == 0xCA {
		if len(data) < 4 {
			return Value{}, io.ErrUnexpectedEOF
		}
		return NumberValue(float64(math.Float32frombits(binary.LittleEndian.Uint32(data)))), nil
	}
	if len(data) < 2 {
		return Value{}, io.ErrUnexpectedEOF
	}
	if dataType == "UInt16" {
		return NumberValue(float64(binary.LittleEndian.Uint16(data))), nil
	}
	if dataType == "Int32" {
		if len(data) < 4 {
			return Value{}, io.ErrUnexpectedEOF
		}
		return NumberValue(float64(int32(binary.LittleEndian.Uint32(data)))), nil
	}
	return NumberValue(float64(int16(binary.LittleEndian.Uint16(data)))), nil
}
