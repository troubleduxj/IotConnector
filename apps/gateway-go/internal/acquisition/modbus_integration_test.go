package acquisition

import (
	"context"
	"encoding/binary"
	"io"
	"net"
	"testing"
	"time"
)

func TestModbusDriverReadsHoldingRegisterOverTCP(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	go serveOneModbusRead(listener)
	port := listener.Addr().(*net.TCPAddr).Port

	updates := make(chan Sample, 2)
	statuses := make(chan ChannelStatus, 8)
	driver := newModbusDriver(
		Channel{ID: "mb-test", Host: "127.0.0.1", Port: port, PollIntervalMs: 200, Params: map[string]any{"slaveId": float64(1)}},
		[]Tag{{ID: "speed", Address: "40001", DataType: "Int16"}},
		func(sample Sample) { updates <- sample },
		func(status ChannelStatus) { statuses <- status },
	).(*modbusDriver)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	if err := driver.Start(ctx); err != nil {
		t.Fatal(err)
	}
	defer driver.Stop(context.Background())
	select {
	case sample := <-updates:
		if sample.Value.Number == nil || *sample.Value.Number != 1234 {
			t.Fatalf("unexpected sample: %#v", sample)
		}
	case <-time.After(2 * time.Second):
		t.Fatalf("driver did not publish a Modbus sample; statuses=%v", drainStatuses(statuses))
	}
}

func drainStatuses(statuses <-chan ChannelStatus) []ChannelStatus {
	result := make([]ChannelStatus, 0)
	for {
		select {
		case status := <-statuses:
			result = append(result, status)
		default:
			return result
		}
	}
}

func serveOneModbusRead(listener net.Listener) {
	conn, err := listener.Accept()
	if err != nil {
		return
	}
	defer conn.Close()
	header := make([]byte, 8)
	if _, err := io.ReadFull(conn, header); err != nil {
		return
	}
	// The eight-byte prefix already consumed MBAP(6) + unit(1) + function(1).
	length := int(binary.BigEndian.Uint16(header[4:6])) - 2
	body := make([]byte, length)
	if _, err := io.ReadFull(conn, body); err != nil {
		return
	}
	response := make([]byte, 11)
	copy(response, header[:7])
	binary.BigEndian.PutUint16(response[4:6], 5)
	response[7] = 3
	response[8] = 2
	binary.BigEndian.PutUint16(response[9:11], 1234)
	_, _ = conn.Write(response)
}
