package acquisition

import (
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"math"
	"net"
	"regexp"
	"strconv"
	"sync"
	"time"
)

var modbusAddressPattern = regexp.MustCompile(`^([0134])(\d{4})$`)

type modbusAddress struct {
	function byte
	offset   uint16
}

// parseModbusAddress maps the project's 1-based notation to zero-based
// protocol offsets: 00001/10001/30001/40001 all map to offset zero.
func parseModbusAddress(address string) (modbusAddress, error) {
	matches := modbusAddressPattern.FindStringSubmatch(address)
	if len(matches) != 3 {
		return modbusAddress{}, fmt.Errorf("invalid Modbus address %q", address)
	}
	prefix, _ := strconv.Atoi(matches[1])
	number, _ := strconv.Atoi(matches[2])
	if number < 1 {
		return modbusAddress{}, fmt.Errorf("invalid Modbus address %q", address)
	}
	function := map[int]byte{0: 1, 1: 2, 3: 4, 4: 3}[prefix]
	return modbusAddress{function: function, offset: uint16(number - 1)}, nil
}

type modbusDriver struct {
	channel   Channel
	tags      []Tag
	publish   func(Sample)
	setStatus func(ChannelStatus)
	mu        sync.Mutex
	conn      net.Conn
	cancel    context.CancelFunc
	done      chan struct{}
	tid       uint16
	unitID    byte
	byteOrder string
}

func newModbusDriver(channel Channel, tags []Tag, publish func(Sample), setStatus func(ChannelStatus)) Driver {
	unitID := byteParam(channel.Params, "slaveId", 1)
	if unitID == 0 {
		unitID = 1
	}
	return &modbusDriver{
		channel: channel, tags: tags, publish: publish, setStatus: setStatus,
		unitID: unitID, byteOrder: stringParam(channel.Params, "byteOrder32", "CDAB"),
	}
}

func (d *modbusDriver) Start(parent context.Context) error {
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

func (d *modbusDriver) Stop(ctx context.Context) error {
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

func (d *modbusDriver) Read(ctx context.Context, tags []Tag) ([]Sample, error) {
	// Connection-level errors abort the read so the caller's reconnect logic runs.
	// Anything else (bad address, Modbus exception response, decode error) is a
	// per-tag failure: the tag gets a Bad-quality sample and the other tags still read.
	isConnectionErr := func(err error) bool {
		var netErr net.Error
		return errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) ||
			errors.Is(err, net.ErrClosed) || errors.As(err, &netErr)
	}
	result := make([]Sample, 0, len(tags))
	for _, tag := range tags {
		value, err := d.readTag(ctx, tag)
		now := time.Now().UnixMilli()
		if err != nil {
			if isConnectionErr(err) {
				return nil, err
			}
			result = append(result, Sample{TagID: tag.ID, Quality: QualityBad, SampledAt: now, ReceivedAt: now})
			continue
		}
		result = append(result, Sample{TagID: tag.ID, Value: value, Quality: QualityGood, SampledAt: now, ReceivedAt: now})
	}
	return result, nil
}

func (d *modbusDriver) Write(ctx context.Context, tag Tag, value Value) error {
	address, err := parseModbusAddress(tag.Address)
	if err != nil {
		return err
	}
	if address.function != 3 && address.function != 1 {
		return fmt.Errorf("Modbus write requires coil or holding register address: %s", tag.Address)
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	if err := d.ensureConnectedLocked(ctx); err != nil {
		return err
	}
	if address.function == 1 {
		if value.Bool == nil {
			return fmt.Errorf("coil write requires bool value")
		}
		return d.writeSingleLocked(ctx, 5, address.offset, boolRegister(*value.Bool))
	}
	if value.Number == nil && value.Bool == nil {
		return fmt.Errorf("register write requires numeric or bool value")
	}
	if tag.DataType == "Float" || tag.DataType == "Int32" {
		if value.Number == nil {
			return fmt.Errorf("%s write requires numeric value", tag.DataType)
		}
		bits := math.Float32bits(float32(*value.Number))
		if tag.DataType == "Int32" {
			bits = uint32(int32(*value.Number))
		}
		logical := make([]byte, 4)
		binary.BigEndian.PutUint32(logical, bits)
		return d.writeMultipleLocked(ctx, address.offset, wireBytes(logical, d.byteOrder))
	}
	register := uint16(0)
	if value.Number != nil {
		register = uint16(*value.Number)
	} else if *value.Bool {
		register = 1
	}
	return d.writeSingleLocked(ctx, 6, address.offset, register)
}

func (d *modbusDriver) Test(ctx context.Context, tags []Tag) error {
	if len(tags) == 0 {
		return fmt.Errorf("Modbus test requires at least one tag")
	}
	_, err := d.readTag(ctx, tags[0])
	return err
}

func (d *modbusDriver) loop(ctx context.Context, done chan struct{}) {
	defer close(done)
	interval := time.Duration(d.channel.PollIntervalMs) * time.Millisecond
	if interval < 200*time.Millisecond {
		interval = 200 * time.Millisecond
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	d.setStatus(ChannelStatus{ID: d.channel.ID, State: "connecting"})
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
			bad := 0
			for _, sample := range samples {
				if sample.Quality == QualityBad {
					bad++
				}
				d.publish(sample)
			}
			// 单个位号失败不再让整个通道离线（C8），但要在状态里看得到，否则点位读不到却显示一切正常。
			// 保持 "OK <n>ms" 前缀：引擎靠它统计周期延迟（statusLatency）。
			detail := fmt.Sprintf("OK %dms", time.Since(started).Milliseconds())
			if bad > 0 {
				detail += fmt.Sprintf(", %d/%d tags bad", bad, len(samples))
			}
			d.setStatus(ChannelStatus{ID: d.channel.ID, State: "online", Detail: detail})
		}
		select {
		case <-ctx.Done():
		case <-ticker.C:
		}
	}
}

func (d *modbusDriver) readTag(ctx context.Context, tag Tag) (Value, error) {
	address, err := parseModbusAddress(tag.Address)
	if err != nil {
		return Value{}, err
	}
	count := uint16(1)
	if tag.DataType == "Float" || tag.DataType == "Int32" || tag.DataType == "Double" {
		count = 2
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	if err := d.ensureConnectedLocked(ctx); err != nil {
		return Value{}, err
	}
	data, err := d.readLocked(ctx, address.function, address.offset, count)
	if err != nil {
		d.closeLocked()
		return Value{}, err
	}
	return decodeModbusValue(data, tag.DataType, d.byteOrder)
}

func (d *modbusDriver) ensureConnectedLocked(ctx context.Context) error {
	if d.conn != nil {
		return nil
	}
	timeout := 4 * time.Second
	if deadline, ok := ctx.Deadline(); ok {
		remaining := time.Until(deadline)
		if remaining < timeout {
			timeout = remaining
		}
	}
	conn, err := dialCaptured(d.channel.ID, "tcp", net.JoinHostPort(d.channel.Host, strconv.Itoa(d.channel.Port)), timeout)
	if err != nil {
		return fmt.Errorf("Modbus TCP connect %s:%d: %w", d.channel.Host, d.channel.Port, err)
	}
	d.conn = conn
	return nil
}

func (d *modbusDriver) readLocked(ctx context.Context, function byte, offset, count uint16) ([]byte, error) {
	d.tid++
	request := make([]byte, 12)
	binary.BigEndian.PutUint16(request[0:2], d.tid)
	binary.BigEndian.PutUint16(request[4:6], 6)
	request[6] = d.unitID
	request[7] = function
	binary.BigEndian.PutUint16(request[8:10], offset)
	binary.BigEndian.PutUint16(request[10:12], count)
	if err := d.roundTripLocked(ctx, request); err != nil {
		return nil, err
	}
	response, err := d.readResponseLocked(ctx)
	if err != nil {
		return nil, err
	}
	if len(response) < 8 {
		return nil, io.ErrUnexpectedEOF
	}
	if response[7] == function|0x80 {
		if len(response) < 9 {
			return nil, io.ErrUnexpectedEOF
		}
		return nil, fmt.Errorf("Modbus exception function=%d code=%d", function, response[8])
	}
	if response[7] != function {
		return nil, fmt.Errorf("invalid Modbus response")
	}
	byteCount := int(response[8])
	if len(response) < 9+byteCount {
		return nil, io.ErrUnexpectedEOF
	}
	return response[9 : 9+byteCount], nil
}

func (d *modbusDriver) writeSingleLocked(ctx context.Context, function byte, offset, value uint16) error {
	d.tid++
	request := make([]byte, 12)
	binary.BigEndian.PutUint16(request[0:2], d.tid)
	binary.BigEndian.PutUint16(request[4:6], 6)
	request[6] = d.unitID
	request[7] = function
	binary.BigEndian.PutUint16(request[8:10], offset)
	binary.BigEndian.PutUint16(request[10:12], value)
	if err := d.roundTripLocked(ctx, request); err != nil {
		return err
	}
	response, err := d.readResponseLocked(ctx)
	if err != nil {
		return err
	}
	if len(response) < 12 || response[7] != function || binary.BigEndian.Uint16(response[8:10]) != offset {
		return fmt.Errorf("invalid Modbus write response")
	}
	return nil
}

func (d *modbusDriver) writeMultipleLocked(ctx context.Context, offset uint16, data []byte) error {
	if len(data) == 0 || len(data)%2 != 0 || len(data) > 246 {
		return fmt.Errorf("invalid Modbus register write length %d", len(data))
	}
	d.tid++
	registers := uint16(len(data) / 2)
	request := make([]byte, 13+len(data))
	binary.BigEndian.PutUint16(request[0:2], d.tid)
	binary.BigEndian.PutUint16(request[4:6], uint16(7+len(data)))
	request[6] = d.unitID
	request[7] = 16
	binary.BigEndian.PutUint16(request[8:10], offset)
	binary.BigEndian.PutUint16(request[10:12], registers)
	request[12] = byte(len(data))
	copy(request[13:], data)
	if err := d.roundTripLocked(ctx, request); err != nil {
		return err
	}
	response, err := d.readResponseLocked(ctx)
	if err != nil {
		return err
	}
	if len(response) < 12 || response[7] != 16 || binary.BigEndian.Uint16(response[8:10]) != offset || binary.BigEndian.Uint16(response[10:12]) != registers {
		return fmt.Errorf("invalid Modbus multiple write response")
	}
	return nil
}

func (d *modbusDriver) roundTripLocked(ctx context.Context, request []byte) error {
	deadline := time.Now().Add(4 * time.Second)
	if ctxDeadline, ok := ctx.Deadline(); ok && ctxDeadline.Before(deadline) {
		deadline = ctxDeadline
	}
	if err := d.conn.SetDeadline(deadline); err != nil {
		return err
	}
	_, err := d.conn.Write(request)
	return err
}

func (d *modbusDriver) readResponseLocked(ctx context.Context) ([]byte, error) {
	_ = ctx
	header := make([]byte, 7)
	if _, err := io.ReadFull(d.conn, header); err != nil {
		return nil, err
	}
	length := int(binary.BigEndian.Uint16(header[4:6]))
	if length < 2 || length > 253 {
		return nil, fmt.Errorf("invalid Modbus PDU length %d", length)
	}
	// The Unit ID is already included in the seven-byte prefix.
	rest := make([]byte, length-1)
	if _, err := io.ReadFull(d.conn, rest); err != nil {
		return nil, err
	}
	return append(header, rest...), nil
}

func (d *modbusDriver) closeLocked() {
	if d.conn != nil {
		_ = d.conn.Close()
		d.conn = nil
	}
}

func decodeModbusValue(data []byte, dataType, order string) (Value, error) {
	if len(data) < 2 {
		return Value{}, io.ErrUnexpectedEOF
	}
	switch dataType {
	case "Bool":
		return BoolValue(binary.BigEndian.Uint16(data) != 0), nil
	case "Int16":
		return NumberValue(float64(int16(binary.BigEndian.Uint16(data)))), nil
	case "UInt16":
		return NumberValue(float64(binary.BigEndian.Uint16(data))), nil
	case "Int32", "Float":
		if len(data) < 4 {
			return Value{}, io.ErrUnexpectedEOF
		}
		logical := logicalBytes(data[:4], order)
		bits := binary.BigEndian.Uint32(logical)
		if dataType == "Int32" {
			return NumberValue(float64(int32(bits))), nil
		}
		return NumberValue(float64(math.Float32frombits(bits))), nil
	default:
		return NumberValue(float64(binary.BigEndian.Uint16(data))), nil
	}
}

func logicalBytes(data []byte, order string) []byte {
	result := append([]byte(nil), data...)
	switch order {
	case "CDAB":
		return []byte{result[2], result[3], result[0], result[1]}
	case "BADC":
		return []byte{result[1], result[0], result[3], result[2]}
	case "DCBA":
		return []byte{result[3], result[2], result[1], result[0]}
	default:
		return result
	}
}

func wireBytes(logical []byte, order string) []byte {
	result := append([]byte(nil), logical...)
	switch order {
	case "CDAB":
		return []byte{result[2], result[3], result[0], result[1]}
	case "BADC":
		return []byte{result[1], result[0], result[3], result[2]}
	case "DCBA":
		return []byte{result[3], result[2], result[1], result[0]}
	default:
		return result
	}
}

func byteParam(params map[string]any, key string, fallback byte) byte {
	value, ok := params[key]
	if !ok {
		return fallback
	}
	switch n := value.(type) {
	case float64:
		return byte(n)
	case int:
		return byte(n)
	case string:
		parsed, err := strconv.Atoi(n)
		if err == nil {
			return byte(parsed)
		}
	}
	return fallback
}

func stringParam(params map[string]any, key, fallback string) string {
	if value, ok := params[key].(string); ok && value != "" {
		return value
	}
	return fallback
}

func boolRegister(value bool) uint16 {
	if value {
		return 0xff00
	}
	return 0
}
