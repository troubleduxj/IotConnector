package acquisition

import (
	"context"
	"encoding/binary"
	"io"
	"net"
	"strconv"
	"strings"
	"sync"
	"testing"
)

// startFakeModbusServer answers FC03 for offset 0 with register value 1234 and
// answers every other holding-register offset with exception code 0x02.
func startFakeModbusServer(t *testing.T) (net.Listener, func() []net.Conn) {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	var mu sync.Mutex
	var conns []net.Conn
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			mu.Lock()
			conns = append(conns, c)
			mu.Unlock()
			go serveModbusConn(c)
		}
	}()
	return ln, func() []net.Conn {
		mu.Lock()
		defer mu.Unlock()
		return append([]net.Conn(nil), conns...)
	}
}

func serveModbusConn(c net.Conn) {
	defer c.Close()
	req := make([]byte, 12)
	for {
		if _, err := io.ReadFull(c, req); err != nil {
			return
		}
		tid := binary.BigEndian.Uint16(req[0:2])
		unit := req[6]
		fc := req[7]
		offset := binary.BigEndian.Uint16(req[8:10])
		var resp []byte
		if fc == 3 && offset == 0 {
			resp = []byte{0, 0, 0, 0, 0, 5, unit, 3, 2, 0x04, 0xD2}
		} else {
			resp = []byte{0, 0, 0, 0, 0, 3, unit, fc | 0x80, 0x02}
		}
		binary.BigEndian.PutUint16(resp[0:2], tid)
		if _, err := c.Write(resp); err != nil {
			return
		}
	}
}

func TestModbusReadPerTagQuality(t *testing.T) {
	ln, conns := startFakeModbusServer(t)
	port := ln.Addr().(*net.TCPAddr).Port
	channel := Channel{ID: "ch1", Protocol: "modbus-tcp", Host: "127.0.0.1", Port: port, PollIntervalMs: 200, Enabled: true}
	tags := []Tag{
		{ID: "good", ChannelID: "ch1", Name: "good", Address: "40001", DataType: "UInt16"},
		{ID: "bad", ChannelID: "ch1", Name: "bad", Address: "40050", DataType: "UInt16"},
	}
	driver := newModbusDriver(channel, tags, func(Sample) {}, func(ChannelStatus) {})
	ctx := context.Background()
	if err := driver.Start(ctx); err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer driver.Stop(ctx)

	samples, err := driver.Read(ctx, tags)
	if err != nil {
		t.Fatalf("Read returned error for per-tag failure: %v", err)
	}
	if len(samples) != 2 {
		t.Fatalf("got %d samples, want 2", len(samples))
	}
	good, bad := samples[0], samples[1]
	if good.TagID != "good" || good.Quality != QualityGood || good.Value.Number == nil || *good.Value.Number != 1234 {
		t.Fatalf("good sample = %#v", good)
	}
	if bad.TagID != "bad" || bad.Quality != QualityBad || bad.Value.Number != nil {
		t.Fatalf("bad sample = %#v", bad)
	}
	if good.SampledAt == 0 || bad.SampledAt == 0 {
		t.Fatalf("timestamps not set: good=%d bad=%d", good.SampledAt, bad.SampledAt)
	}

	// Close the listener and every accepted server connection: Read must now
	// fail with a connection-level error so reconnect logic runs.
	ln.Close()
	for _, c := range conns() {
		c.Close()
	}
	if _, err := driver.Read(ctx, tags); err == nil {
		t.Fatal("Read after server closed: expected connection error, got nil")
	}
}

func TestModbusErrorClassification(t *testing.T) {
	// Dial failure on a closed port is a net.Error, so it must be connection-level.
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	port := ln.Addr().(*net.TCPAddr).Port
	ln.Close()
	channel := Channel{ID: "ch2", Host: "127.0.0.1", Port: port, PollIntervalMs: 200}
	tags := []Tag{{ID: "t", ChannelID: "ch2", Address: "40001", DataType: "UInt16"}}
	driver := newModbusDriver(channel, tags, func(Sample) {}, func(ChannelStatus) {})
	if _, err := driver.Read(context.Background(), tags); err == nil {
		t.Fatal("expected connection error for refused dial, got nil")
	}
}

// 部分位号失败时通道仍 online，状态详情注明坏位号数，且周期延迟仍能被引擎统计。
func TestModbusLoopReportsBadTagCount(t *testing.T) {
	server := newFakeModbusServer(t)
	defer server.Close()
	host, portText, _ := net.SplitHostPort(server.Addr())
	port, _ := strconv.Atoi(portText)
	statuses := make(chan ChannelStatus, 64)
	d := newModbusDriver(Channel{ID: "mq", Host: host, Port: port, PollIntervalMs: 200},
		[]Tag{{ID: "good", Address: "40001", DataType: "UInt16"}, {ID: "bad", Address: "40050", DataType: "UInt16"}},
		func(Sample) {}, func(s ChannelStatus) {
			select {
			case statuses <- s:
			default:
			}
		})
	if err := d.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	defer d.Stop(context.Background())
	deadline := time.After(5 * time.Second)
	for {
		select {
		case s := <-statuses:
			if s.State != "online" {
				continue
			}
			if !strings.Contains(s.Detail, "1/2 tags bad") {
				t.Fatalf("detail = %q", s.Detail)
			}
			if _, ok := statusLatency(s.Detail); !ok {
				t.Fatalf("latency not parseable from %q", s.Detail)
			}
			return
		case <-deadline:
			t.Fatal("no online status")
		}
	}
}
