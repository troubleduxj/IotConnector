package acquisition

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

const (
	iecStart     = 0x68
	iecMSp       = 1
	iecMMeNc     = 13
	iecCic       = 100
	iecCotAct    = 6
	iecCotInterr = 20
)

type iecPoint struct {
	ioa   uint32
	value Value
	qds   byte
}

type iecFrame struct {
	kind    byte
	sendSeq uint16
	recvSeq uint16
	typeID  byte
	cot     uint16
	common  uint16
	points  []iecPoint
}

type iec104Driver struct {
	channel   Channel
	tags      []Tag
	publish   func(Sample)
	setStatus func(ChannelStatus)

	mu      sync.RWMutex
	conn    net.Conn
	latest  map[string]Value
	sendSeq uint16
	recvSeq uint16
	cancel  context.CancelFunc
	done    chan struct{}
}

func newIEC104Driver(channel Channel, tags []Tag, publish func(Sample), setStatus func(ChannelStatus)) Driver {
	return &iec104Driver{channel: channel, tags: tags, publish: publish, setStatus: setStatus, latest: make(map[string]Value)}
}

func (d *iec104Driver) Start(parent context.Context) error {
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

func (d *iec104Driver) Stop(ctx context.Context) error {
	d.mu.Lock()
	cancel, done, conn := d.cancel, d.done, d.conn
	d.cancel, d.conn = nil, nil
	d.mu.Unlock()
	if cancel == nil {
		return nil
	}
	cancel()
	if conn != nil {
		_ = conn.Close()
	}
	select {
	case <-done:
		d.setStatus(ChannelStatus{ID: d.channel.ID, State: "disabled", Detail: "stopped"})
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (d *iec104Driver) Read(ctx context.Context, tags []Tag) ([]Sample, error) {
	d.mu.RLock()
	values := make(map[string]Value, len(d.latest))
	for id, value := range d.latest {
		values[id] = value
	}
	d.mu.RUnlock()
	if len(values) == 0 {
		return nil, fmt.Errorf("IEC104 has not received interrogation data")
	}
	now := time.Now().UnixMilli()
	result := make([]Sample, 0, len(tags))
	for _, tag := range tags {
		if value, ok := values[tag.ID]; ok {
			result = append(result, Sample{TagID: tag.ID, Value: value, Quality: QualityGood, SampledAt: now, ReceivedAt: now})
		}
	}
	if len(result) == 0 {
		return nil, fmt.Errorf("IEC104 has no values for configured IOA")
	}
	return result, nil
}

func (d *iec104Driver) Write(context.Context, Tag, Value) error {
	return fmt.Errorf("IEC104 write is not supported by the current migration scope")
}

func (d *iec104Driver) Test(ctx context.Context, tags []Tag) error {
	_, err := d.Read(ctx, tags)
	return err
}

func (d *iec104Driver) loop(ctx context.Context) {
	defer close(d.done)
	interval := time.Duration(d.channel.PollIntervalMs) * time.Millisecond
	if interval < time.Second {
		interval = time.Second
	}
	for {
		if ctx.Err() != nil {
			return
		}
		address := net.JoinHostPort(d.channel.Host, strconv.Itoa(d.channel.Port))
		conn, err := net.DialTimeout("tcp", address, 3*time.Second)
		if err != nil {
			d.setStatus(ChannelStatus{ID: d.channel.ID, State: "offline", Detail: "IEC104 connect " + address + ": " + err.Error()})
			select {
			case <-ctx.Done():
				return
			case <-time.After(2 * time.Second):
				continue
			}
		}
		d.mu.Lock()
		d.conn = conn
		d.sendSeq, d.recvSeq = 0, 0
		d.mu.Unlock()
		err = d.session(ctx, conn, interval)
		_ = conn.Close()
		d.mu.Lock()
		if d.conn == conn {
			d.conn = nil
		}
		d.mu.Unlock()
		if err != nil && ctx.Err() == nil {
			d.setStatus(ChannelStatus{ID: d.channel.ID, State: "offline", Detail: err.Error()})
		}
	}
}

func (d *iec104Driver) session(ctx context.Context, conn net.Conn, interval time.Duration) error {
	if _, err := conn.Write([]byte{0x68, 0x04, 0x07, 0, 0, 0}); err != nil {
		return err
	}
	buf := make([]byte, 0, 4096)
	started := false
	lastInterrogation := time.Time{}
	tick := time.NewTicker(interval)
	defer tick.Stop()
	for {
		_ = conn.SetReadDeadline(time.Now().Add(500 * time.Millisecond))
		chunk := make([]byte, 2048)
		n, err := conn.Read(chunk)
		if n > 0 {
			buf = append(buf, chunk[:n]...)
			frames, rest := splitIECFrames(buf)
			buf = rest
			for _, raw := range frames {
				frame := decodeIECFrame(raw)
				switch frame.kind {
				case 0x0b:
					started = true
					d.setStatus(ChannelStatus{ID: d.channel.ID, State: "online", Detail: "STARTDT confirmed"})
				case 0x00:
					d.handleIECData(frame)
					if frame.sendSeq >= d.recvSeq {
						d.recvSeq = frame.sendSeq + 1
					}
					_, _ = conn.Write(encodeIECSFrame(d.recvSeq))
				}
			}
		}
		if err != nil && !isTimeout(err) {
			return err
		}
		if started && (lastInterrogation.IsZero() || time.Since(lastInterrogation) >= interval) {
			if err := d.sendInterrogation(conn); err != nil {
				return err
			}
			lastInterrogation = time.Now()
		}
		select {
		case <-ctx.Done():
			return nil
		default:
		}
	}
}

func (d *iec104Driver) sendInterrogation(conn net.Conn) error {
	common := 1
	if raw, ok := d.channel.Params["commonAddress"]; ok {
		if n, err := strconv.Atoi(fmt.Sprint(raw)); err == nil && n > 0 {
			common = n
		}
	}
	qoi := byte(20)
	asdu := []byte{iecCic, 1, iecCotAct, 0, byte(common), byte(common >> 8), 0, 0, 0, qoi}
	d.mu.Lock()
	seq, ack := d.sendSeq, d.recvSeq
	d.sendSeq++
	d.mu.Unlock()
	frame := encodeIECIFrame(asdu, seq, ack)
	_, err := conn.Write(frame)
	return err
}

func (d *iec104Driver) handleIECData(frame iecFrame) {
	for _, point := range frame.points {
		for _, tag := range d.tags {
			ioa := strings.TrimPrefix(strings.ToUpper(strings.TrimSpace(tag.Address)), "IOA:")
			want, err := strconv.ParseUint(ioa, 10, 32)
			if err != nil || uint32(want) != point.ioa {
				continue
			}
			if (frame.typeID == iecMSp && tag.DataType == "Bool") || (frame.typeID == iecMMeNc && tag.DataType != "Bool") {
				d.mu.Lock()
				d.latest[tag.ID] = point.value
				d.mu.Unlock()
				now := time.Now().UnixMilli()
				d.publish(Sample{TagID: tag.ID, Value: point.value, Quality: QualityGood, SampledAt: now, ReceivedAt: now})
			}
		}
	}
}

func isTimeout(err error) bool {
	if e, ok := err.(net.Error); ok {
		return e.Timeout()
	}
	return false
}

func splitIECFrames(buf []byte) ([][]byte, []byte) {
	frames := make([][]byte, 0, 2)
	for len(buf) >= 2 {
		if buf[0] != iecStart {
			buf = buf[1:]
			continue
		}
		length := int(buf[1])
		if len(buf) < length+2 {
			break
		}
		frames = append(frames, append([]byte(nil), buf[:length+2]...))
		buf = buf[length+2:]
	}
	return frames, buf
}

func decodeIECFrame(buf []byte) iecFrame {
	if len(buf) < 6 {
		return iecFrame{kind: 0xff}
	}
	c0 := buf[2]
	if c0&3 == 3 {
		return iecFrame{kind: c0}
	}
	if c0&3 == 1 {
		return iecFrame{kind: 0x01, recvSeq: uint16(buf[4]>>1) | uint16(buf[5])<<7}
	}
	f := iecFrame{kind: 0, sendSeq: uint16(buf[2]>>1) | uint16(buf[3])<<7, recvSeq: uint16(buf[4]>>1) | uint16(buf[5])<<7}
	if len(buf) < 12 {
		return f
	}
	b := buf[6:]
	f.typeID = b[0]
	count := int(b[1] & 0x7f)
	f.cot = binary.LittleEndian.Uint16(b[2:4])
	f.common = binary.LittleEndian.Uint16(b[4:6])
	o := 6
	for i := 0; i < count && o+3 <= len(b); i++ {
		ioa := uint32(b[o]) | uint32(b[o+1])<<8 | uint32(b[o+2])<<16
		o += 3
		if f.typeID == iecMSp && o < len(b) {
			q := b[o]
			o++
			f.points = append(f.points, iecPoint{ioa: ioa, value: BoolValue(q&1 != 0), qds: q})
		} else if f.typeID == iecMMeNc && o+5 <= len(b) {
			v := math.Float32frombits(binary.LittleEndian.Uint32(b[o:]))
			q := b[o+4]
			o += 5
			f.points = append(f.points, iecPoint{ioa: ioa, value: NumberValue(float64(v)), qds: q})
		} else {
			break
		}
	}
	return f
}

func encodeIECIFrame(asdu []byte, send, recv uint16) []byte {
	f := make([]byte, len(asdu)+6)
	f[0], f[1] = iecStart, byte(len(asdu)+4)
	f[2], f[3] = byte(send<<1), byte(send>>7)
	f[4], f[5] = byte(recv<<1), byte(recv>>7)
	copy(f[6:], asdu)
	return f
}

func encodeIECSFrame(recv uint16) []byte {
	return []byte{iecStart, 4, 1, 0, byte(recv << 1), byte(recv >> 7)}
}
