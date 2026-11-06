package acquisition

// BACnet/IP client.  This deliberately keeps the transport small and explicit:
// BVLC original-unicast + local NPDU + confirmed services.  It matches the
// wire subset exposed by ProtoForge while remaining usable with ordinary
// BACnet/IP devices that support ReadProperty/WriteProperty.
import (
	"context"
	"encoding/binary"
	"fmt"
	"math"
	"net"
	"strconv"
	"strings"
	"sync"
	"time"
)

const bacnetPresentValue = 85

var bacnetTypes = map[string]byte{"AI": 0, "AO": 1, "AV": 2, "BI": 3, "BO": 4, "BV": 5}

type bacnetBinding struct {
	tag        Tag
	objectType byte
	instance   uint32
}

// BACnetDevice describes an I-Am response returned by Discover.
type BACnetDevice struct {
	ID           uint32
	Address      string
	MaxAPDU      uint16
	Segmentation byte
	VendorID     uint16
}

type BACnetCOVNotification struct {
	ProcessID      byte
	ObjectType     byte
	ObjectInstance uint32
}
type bacnetDriver struct {
	channel   Channel
	tags      []Tag
	publish   func(Sample)
	setStatus func(ChannelStatus)
	mu        sync.Mutex
	ioMu      sync.Mutex
	conn      *net.UDPConn
	cancel    context.CancelFunc
	done      chan struct{}
	invoke    byte
}

func newBACnetDriver(c Channel, tags []Tag, publish func(Sample), status func(ChannelStatus)) Driver {
	return &bacnetDriver{channel: c, tags: tags, publish: publish, setStatus: status, invoke: 1}
}

func (d *bacnetDriver) Start(parent context.Context) error {
	if _, err := d.bindings(); err != nil {
		return err
	}
	d.mu.Lock()
	if d.cancel != nil {
		d.mu.Unlock()
		return nil
	}
	ctx, cancel := context.WithCancel(parent)
	d.cancel = cancel
	d.done = make(chan struct{})
	d.mu.Unlock()
	go d.loop(ctx)
	return nil
}
func (d *bacnetDriver) Stop(ctx context.Context) error {
	d.mu.Lock()
	cancel, done := d.cancel, d.done
	d.cancel = nil
	if d.conn != nil {
		_ = d.conn.Close()
		d.conn = nil
	}
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
func (d *bacnetDriver) Read(ctx context.Context, tags []Tag) ([]Sample, error) {
	bindings, err := d.bindings()
	if err != nil {
		return nil, err
	}
	values, err := d.readProperties(ctx, bindings)
	if err != nil {
		return nil, err
	}
	result := make([]Sample, 0, len(tags))
	now := time.Now().UnixMilli()
	for _, tag := range tags {
		v, ok := values[tag.ID]
		if !ok {
			continue
		}
		result = append(result, Sample{TagID: tag.ID, Value: v, Quality: QualityGood, SampledAt: now, ReceivedAt: now})
	}
	return result, nil
}
func (d *bacnetDriver) Write(ctx context.Context, tag Tag, value Value) error {
	b, err := d.bindingFor(tag)
	if err != nil {
		return err
	}
	raw, err := bacnetRawValue(value, tag.DataType)
	if err != nil {
		return err
	}
	id := d.nextInvoke()
	// WriteProperty request body uses context tags [0] object-id, [1]
	// property-id, and opening/closing [3] around application values.
	body := []byte{0x0c}
	body = append(body, encodeObjectID(b.objectType, b.instance)...)
	body = append(body, 0x19, byte(bacnetPresentValue), 0x3e)
	body = append(body, raw...)
	body = append(body, 0x3f)
	// Standard non-segmented confirmed request:
	// PDU type (segmented response accepted), max-segments/max-APDU,
	// invoke-id, service-choice, service body.
	apdu := append([]byte{0x02, 0x00, id, 0x0f}, body...)
	_, err = d.roundTrip(ctx, apdu)
	return err
}
func (d *bacnetDriver) Test(ctx context.Context, tags []Tag) error {
	if len(tags) == 0 {
		return fmt.Errorf("BACnet test requires at least one tag")
	}
	_, err := d.Read(ctx, tags[:1])
	return err
}

// Discover sends Who-Is and collects I-Am responses from the configured
// BACnet endpoint. It is intentionally independent from the polling tags so
// a management station can discover a device before creating bindings.
func (d *bacnetDriver) Discover(ctx context.Context) ([]BACnetDevice, error) {
	d.ioMu.Lock()
	defer d.ioMu.Unlock()
	d.mu.Lock()
	if d.conn == nil {
		c, err := net.ListenUDP("udp4", &net.UDPAddr{IP: net.IPv4zero, Port: 0})
		if err != nil {
			d.mu.Unlock()
			return nil, err
		}
		d.conn = c
	}
	conn := d.conn
	d.mu.Unlock()
	target := &net.UDPAddr{IP: net.ParseIP(d.channel.Host), Port: d.channel.Port}
	if target.IP == nil {
		return nil, fmt.Errorf("invalid BACnet host %q", d.channel.Host)
	}
	// BVLC + NPDU + Unconfirmed Who-Is. No device range is supplied.
	packet := []byte{0x81, 0x0a, 0x00, 0x08, 0x01, 0x00, 0x10, 0x08}
	if _, err := conn.WriteToUDP(packet, target); err != nil {
		return nil, err
	}
	deadline := time.Now().Add(3 * time.Second)
	if t, ok := ctx.Deadline(); ok && t.Before(deadline) {
		deadline = t
	}
	_ = conn.SetReadDeadline(deadline)
	buf := make([]byte, 65535)
	devices := make([]BACnetDevice, 0, 4)
	for {
		n, addr, err := conn.ReadFromUDP(buf)
		if err != nil {
			if ne, ok := err.(net.Error); ok && ne.Timeout() {
				break
			}
			return nil, err
		}
		frame := buf[:n]
		device, ok := decodeBACnetIAm(frame, addr.String())
		if !ok {
			continue
		}
		duplicate := false
		for _, existing := range devices {
			if existing.ID == device.ID && existing.Address == device.Address {
				duplicate = true
				break
			}
		}
		if !duplicate {
			devices = append(devices, device)
		}
	}
	if len(devices) == 0 {
		return nil, fmt.Errorf("BACnet Who-Is timed out")
	}
	return devices, nil
}

// SubscribeCOV registers a confirmed COV subscription for one object. The
// notification payload is delivered asynchronously by the device; this
// method verifies the Simple-ACK and leaves the existing polling path intact.
func (d *bacnetDriver) SubscribeCOV(ctx context.Context, tag Tag, processID byte, lifetime uint32) error {
	b, err := d.bindingFor(tag)
	if err != nil {
		return err
	}
	id := d.nextInvoke()
	body := []byte{0x09, processID, 0x1c}
	body = append(body, encodeObjectID(b.objectType, b.instance)...)
	if lifetime > 0 {
		switch {
		case lifetime <= 0xff:
			body = append(body, 0x39, byte(lifetime))
		case lifetime <= 0xffff:
			body = append(body, 0x3a, byte(lifetime>>8), byte(lifetime))
		default:
			body = append(body, 0x3c, byte(lifetime>>24), byte(lifetime>>16), byte(lifetime>>8), byte(lifetime))
		}
	}
	apdu := append([]byte{0x02, 0x00, id, 0x05}, body...)
	packet, err := d.roundTrip(ctx, apdu)
	if err != nil {
		return err
	}
	if len(packet) < 9 || packet[6] != 0x20 || packet[8] != 0x05 {
		return fmt.Errorf("invalid BACnet SubscribeCOV acknowledgement")
	}
	return nil
}

// CancelCOV uses BACnet lifetime=0 for the matching subscriber/object.
func (d *bacnetDriver) CancelCOV(ctx context.Context, tag Tag, processID byte) error {
	b, err := d.bindingFor(tag)
	if err != nil {
		return err
	}
	id := d.nextInvoke()
	body := append([]byte{0x09, processID, 0x1c}, encodeObjectID(b.objectType, b.instance)...)
	body = append(body, 0x39, 0x00)
	apdu := append([]byte{0x02, 0x00, id, 0x05}, body...)
	packet, err := d.roundTrip(ctx, apdu)
	if err != nil {
		return err
	}
	if len(packet) < 9 || packet[6] != 0x20 || packet[8] != 0x05 {
		return fmt.Errorf("invalid BACnet CancelCOV acknowledgement")
	}
	return nil
}

func decodeBACnetIAm(packet []byte, address string) (BACnetDevice, bool) {
	if len(packet) < 10 || packet[0] != 0x81 || packet[6] != 0x10 || packet[7] != 0x00 {
		return BACnetDevice{}, false
	}
	off := 8
	device := BACnetDevice{Address: address}
	for off < len(packet) {
		tag := packet[off]
		off++
		if off > len(packet) {
			return BACnetDevice{}, false
		}
		length := int(tag & 0x07)
		if length == 5 {
			if off >= len(packet) {
				return BACnetDevice{}, false
			}
			length = int(packet[off])
			off++
		}
		if off+length > len(packet) {
			return BACnetDevice{}, false
		}
		value := packet[off : off+length]
		switch tag & 0xf8 {
		case 0x08: // context tag 0: device object identifier
			if length != 4 {
				return BACnetDevice{}, false
			}
			_, device.ID = decodeObjectID(value)
		case 0x18: // context tag 1: max APDU length
			device.MaxAPDU = uint16FromBACnet(value)
		case 0x28: // context tag 2: segmentation
			if length == 1 {
				device.Segmentation = value[0]
			}
		case 0x38: // context tag 3: vendor id
			device.VendorID = uint16FromBACnet(value)
		}
		off += length
	}
	return device, device.ID != 0
}

func uint16FromBACnet(value []byte) uint16 {
	var result uint16
	for _, b := range value {
		result = (result << 8) | uint16(b)
	}
	return result
}

func decodeBACnetCOVNotification(packet []byte) (BACnetCOVNotification, bool) {
	if len(packet) < 20 || packet[0] != 0x81 || packet[6] != 0x10 || packet[7] != 0x02 {
		return BACnetCOVNotification{}, false
	}
	off := 8
	if off+2 > len(packet) || packet[off]&0xf0 != 0x80 {
		return BACnetCOVNotification{}, false
	}
	n := int(packet[off] & 0x07)
	off++
	if n != 1 || off+n > len(packet) {
		return BACnetCOVNotification{}, false
	}
	result := BACnetCOVNotification{ProcessID: packet[off]}
	off += n
	if off+5 > len(packet) || packet[off]&0xf0 != 0xc0 {
		return BACnetCOVNotification{}, false
	}
	off++
	// initiating device identifier
	off += 4
	if off+5 > len(packet) || packet[off]&0xf0 != 0xc0 {
		return BACnetCOVNotification{}, false
	}
	off++
	result.ObjectType, result.ObjectInstance = decodeObjectID(packet[off : off+4])
	return result, true
}
func (d *bacnetDriver) loop(ctx context.Context) {
	defer close(d.done)
	interval := time.Duration(d.channel.PollIntervalMs) * time.Millisecond
	if interval < 200*time.Millisecond {
		interval = 200 * time.Millisecond
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	d.setStatus(ChannelStatus{ID: d.channel.ID, State: "connecting"})
	for {
		started := time.Now()
		samples, err := d.Read(ctx, d.tags)
		if err != nil {
			d.setStatus(ChannelStatus{ID: d.channel.ID, State: "offline", Detail: err.Error()})
		} else {
			for _, s := range samples {
				d.publish(s)
			}
			d.setStatus(ChannelStatus{ID: d.channel.ID, State: "online", Detail: fmt.Sprintf("OK %dms", time.Since(started).Milliseconds())})
		}
		select {
		case <-ctx.Done():
			d.setStatus(ChannelStatus{ID: d.channel.ID, State: "disabled", Detail: "stopped"})
			return
		case <-ticker.C:
		}
	}
}

func (d *bacnetDriver) bindings() ([]bacnetBinding, error) {
	out := make([]bacnetBinding, 0, len(d.tags))
	for _, t := range d.tags {
		b, err := d.bindingFor(t)
		if err != nil {
			return nil, err
		}
		out = append(out, b)
	}
	return out, nil
}
func (d *bacnetDriver) bindingFor(t Tag) (bacnetBinding, error) {
	parts := strings.Split(strings.ToUpper(strings.TrimSpace(t.Address)), ":")
	if len(parts) != 2 {
		return bacnetBinding{}, fmt.Errorf("invalid BACnet address %q", t.Address)
	}
	typ, ok := bacnetTypes[parts[0]]
	if !ok {
		return bacnetBinding{}, fmt.Errorf("unsupported BACnet object type %q", parts[0])
	}
	n, err := strconv.ParseUint(parts[1], 10, 22)
	if err != nil {
		return bacnetBinding{}, fmt.Errorf("invalid BACnet instance %q", t.Address)
	}
	return bacnetBinding{tag: t, objectType: typ, instance: uint32(n)}, nil
}
func encodeObjectID(typ byte, inst uint32) []byte {
	v := (uint32(typ)&0x3ff)<<22 | (inst & 0x3fffff)
	b := make([]byte, 4)
	binary.BigEndian.PutUint32(b, v)
	return b
}
func decodeObjectID(b []byte) (byte, uint32) {
	v := binary.BigEndian.Uint32(b)
	return byte((v >> 22) & 0x3ff), v & 0x3fffff
}
func (d *bacnetDriver) nextInvoke() byte {
	d.mu.Lock()
	defer d.mu.Unlock()
	id := d.invoke
	d.invoke++
	if d.invoke == 0 {
		d.invoke = 1
	}
	return id
}
func (d *bacnetDriver) readProperties(ctx context.Context, bs []bacnetBinding) (map[string]Value, error) {
	if len(bs) == 0 {
		return map[string]Value{}, nil
	}
	id := d.nextInvoke()
	body := make([]byte, 0, len(bs)*12)
	for _, b := range bs {
		body = append(body, 0x0c)
		body = append(body, encodeObjectID(b.objectType, b.instance)...)
		body = append(body, 0x1e, 0x09, bacnetPresentValue, 0x1f)
	}
	apdu := append([]byte{0x02, 0x00, id, 0x0e}, body...)
	packet, err := d.roundTrip(ctx, apdu)
	if err != nil {
		return nil, err
	}
	return parseBACnetRPM(packet, bs)
}
func (d *bacnetDriver) roundTrip(ctx context.Context, apdu []byte) ([]byte, error) {
	// Serialize request/response pairs on one UDP socket, but do not hold the
	// lifecycle mutex while waiting on the network. Stop can then close the
	// socket immediately and unblock a pending read during a device outage.
	d.ioMu.Lock()
	defer d.ioMu.Unlock()

	d.mu.Lock()
	if d.conn == nil {
		local := &net.UDPAddr{IP: net.IPv4zero, Port: 0}
		c, err := net.ListenUDP("udp4", local)
		if err != nil {
			d.mu.Unlock()
			return nil, err
		}
		d.conn = c
	}
	conn := d.conn
	d.mu.Unlock()
	target := &net.UDPAddr{IP: net.ParseIP(d.channel.Host), Port: d.channel.Port}
	if target.IP == nil {
		return nil, fmt.Errorf("invalid BACnet host %q", d.channel.Host)
	}
	packet := append([]byte{0x81, 0x0a, 0, 0, 1, 0}, apdu...)
	binary.BigEndian.PutUint16(packet[2:4], uint16(len(packet)))
	deadline := time.Now().Add(3 * time.Second)
	if t, ok := ctx.Deadline(); ok && t.Before(deadline) {
		deadline = t
	}
	_ = conn.SetDeadline(deadline)
	if _, err := conn.WriteToUDP(packet, target); err != nil {
		return nil, err
	}
	buf := make([]byte, 65535)
	n, _, err := conn.ReadFromUDP(buf)
	if err != nil {
		return nil, err
	}
	if n < 8 || buf[0] != 0x81 {
		return nil, fmt.Errorf("invalid BACnet response")
	}
	expectedInvoke := apdu[2]
	if buf[6] == 0x30 {
		if n < 10 || buf[7] != expectedInvoke {
			return nil, fmt.Errorf("BACnet invoke mismatch")
		}
	} else if n < 8 || buf[7] != expectedInvoke {
		return nil, fmt.Errorf("BACnet invoke mismatch")
	}
	if (buf[6] == 0x30 && buf[8] == 0x50) || buf[6] == 0x50 {
		return nil, fmt.Errorf("BACnet error response")
	}
	return append([]byte(nil), buf[:n]...), nil
}

func parseBACnetRPM(packet []byte, bs []bacnetBinding) (map[string]Value, error) {
	out := map[string]Value{}
	if len(packet) < 8 {
		return nil, fmt.Errorf("short BACnet response")
	}
	off := 8
	service := packet[7]
	if packet[6] == 0x30 {
		if len(packet) < 10 {
			return nil, fmt.Errorf("short BACnet complex ack")
		}
		off = 10
		service = packet[9]
	}
	if service != 0x0e {
		return nil, fmt.Errorf("unsupported BACnet service 0x%02x", service)
	}
	for off+5 <= len(packet) {
		// Standard ReadAccessResult: context object-id [0], opening [1],
		// context property-id [2], opening value [4], application value,
		// closing [4], closing [1]. Keep the compact parser for older fixtures.
		standard := packet[off] == 0x0c
		if standard {
			off++
		}
		if off+4 > len(packet) {
			return nil, fmt.Errorf("truncated BACnet object identifier")
		}
		typ, inst := decodeObjectID(packet[off : off+4])
		off += 4
		if standard {
			if off >= len(packet) || packet[off] != 0x1e {
				return nil, fmt.Errorf("invalid BACnet property list")
			}
			off++
			for off < len(packet) && packet[off] != 0x1f {
				if off+2 > len(packet) || packet[off] != 0x29 {
					return nil, fmt.Errorf("invalid BACnet property reference")
				}
				off++
				pid := packet[off]
				off++
				if off >= len(packet) || packet[off] != 0x4e {
					return nil, fmt.Errorf("invalid BACnet property value")
				}
				off++
				v, n, err := decodeBACnetApplication(packet[off:])
				if err != nil {
					return nil, err
				}
				off += n
				if off >= len(packet) || packet[off] != 0x4f {
					return nil, fmt.Errorf("unterminated BACnet property value")
				}
				off++
				if pid == bacnetPresentValue {
					for _, b := range bs {
						if b.objectType == typ && b.instance == inst {
							out[b.tag.ID] = convertBACnetValue(v, b.tag.DataType)
						}
					}
				}
			}
			if off >= len(packet) || packet[off] != 0x1f {
				return nil, fmt.Errorf("unterminated BACnet property list")
			}
			off++
			continue
		}
		if off >= len(packet) {
			break
		}
		count := int(packet[off])
		off++
		for i := 0; i < count && off < len(packet); i++ {
			pid := packet[off]
			off++
			v, n, err := decodeBACnetApplication(packet[off:])
			if err != nil {
				return nil, err
			}
			off += n
			if pid == bacnetPresentValue {
				for _, b := range bs {
					if b.objectType == typ && b.instance == inst {
						out[b.tag.ID] = convertBACnetValue(v, b.tag.DataType)
					}
				}
			}
		}
	}
	if len(out) == 0 {
		return nil, fmt.Errorf("no BACnet values returned")
	}
	return out, nil
}
func decodeBACnetApplication(b []byte) (any, int, error) {
	if len(b) < 1 {
		return nil, 0, fmt.Errorf("truncated BACnet value")
	}
	tag := b[0]
	switch tag {
	case 0x19:
		if len(b) < 2 {
			return nil, 0, fmt.Errorf("truncated boolean")
		}
		return b[1] != 0, 2, nil
	case 0x44:
		if len(b) < 5 {
			return nil, 0, fmt.Errorf("truncated real")
		}
		return float64(math.Float32frombits(binary.BigEndian.Uint32(b[1:5]))), 5, nil
	case 0x21:
		if len(b) < 2 {
			return nil, 0, fmt.Errorf("truncated unsigned")
		}
		return float64(b[1]), 2, nil
	case 0x22:
		if len(b) < 3 {
			return nil, 0, fmt.Errorf("truncated unsigned")
		}
		return float64(binary.BigEndian.Uint16(b[1:3])), 3, nil
	case 0x24:
		if len(b) < 5 {
			return nil, 0, fmt.Errorf("truncated unsigned")
		}
		return float64(binary.BigEndian.Uint32(b[1:5])), 5, nil
	case 0x75:
		if len(b) < 3 {
			return nil, 0, fmt.Errorf("truncated string")
		}
		n := int(binary.BigEndian.Uint16(b[1:3]))
		if len(b) < 3+n {
			return nil, 0, fmt.Errorf("truncated string")
		}
		return string(b[3 : 3+n]), 3 + n, nil
	}
	return nil, 0, fmt.Errorf("unsupported BACnet application tag 0x%02x", tag)
}
func convertBACnetValue(v any, typ string) Value {
	if strings.EqualFold(typ, "Bool") {
		b, _ := v.(bool)
		return BoolValue(b)
	}
	switch x := v.(type) {
	case float64:
		return NumberValue(x)
	case string:
		return StringValue(x)
	case bool:
		return BoolValue(x)
	}
	return StringValue(fmt.Sprint(v))
}
func bacnetRawValue(v Value, typ string) ([]byte, error) {
	if strings.EqualFold(typ, "Bool") {
		if v.Bool == nil {
			return nil, fmt.Errorf("BACnet bool write requires bool")
		}
		if *v.Bool {
			return []byte{0x19, 1}, nil
		}
		return []byte{0x19, 0}, nil
	}
	if v.Number != nil {
		return []byte{0x44, byte(math.Float32bits(float32(*v.Number)) >> 24), byte(math.Float32bits(float32(*v.Number)) >> 16), byte(math.Float32bits(float32(*v.Number)) >> 8), byte(math.Float32bits(float32(*v.Number)))}, nil
	}
	if v.String != nil {
		b := []byte(*v.String)
		out := []byte{0x75, byte(len(b) >> 8), byte(len(b))}
		return append(out, b...), nil
	}
	return nil, fmt.Errorf("BACnet write requires value")
}
