package acquisition

import (
	"context"
	"encoding/binary"
	"io"
	"net"
	"testing"
	"time"
)

func TestParseMCAddressAndDecode(t *testing.T) {
	address, err := parseMCAddress("D100")
	if err != nil || address.device != "D" || address.number != 100 {
		t.Fatalf("unexpected address: %#v %v", address, err)
	}
	if _, err := parseMCAddress("DB100"); err == nil {
		t.Fatal("expected invalid MELSEC address")
	}
	value, err := decodeMCValue([]byte{0xFF, 0xFE}, "Int16")
	if err != nil || value.Number == nil || *value.Number != -2 {
		t.Fatalf("unexpected decoded value: %#v %v", value, err)
	}
}

func TestMelsecDriverReadsAndWritesMC3E(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	serverDone := make(chan error, 1)
	go func() {
		conn, acceptErr := listener.Accept()
		if acceptErr != nil {
			serverDone <- acceptErr
			return
		}
		defer conn.Close()
		for i := 0; i < 2; i++ {
			header := make([]byte, 9)
			if _, err := io.ReadFull(conn, header); err != nil {
				serverDone <- err
				return
			}
			body := make([]byte, int(binary.LittleEndian.Uint16(header[7:9])))
			if _, err := io.ReadFull(conn, body); err != nil {
				serverDone <- err
				return
			}
			responseData := []byte{0x00, 0x00}
			if i == 0 {
				responseData = append(responseData, 0x00, 0x2A)
			}
			response := mcHeader(len(responseData))
			response[0] = 0xD0
			response = append(response, responseData...)
			if _, err := conn.Write(response); err != nil {
				serverDone <- err
				return
			}
		}
		serverDone <- nil
	}()

	var samples []Sample
	driver := newMelsecDriver(
		Channel{ID: "mc-1", Host: "127.0.0.1", Port: listener.Addr().(*net.TCPAddr).Port, PollIntervalMs: 1000},
		[]Tag{{ID: "tag-1", Address: "D100", DataType: "Int16"}},
		func(sample Sample) { samples = append(samples, sample) },
		func(ChannelStatus) {},
	).(*melsecDriver)
	read, err := driver.Read(context.Background(), driver.tags)
	if err != nil {
		t.Fatal(err)
	}
	if len(read) != 1 || read[0].Value.Number == nil || *read[0].Value.Number != 42 {
		t.Fatalf("unexpected read: %#v", read)
	}
	if err := driver.Write(context.Background(), driver.tags[0], NumberValue(7)); err != nil {
		t.Fatal(err)
	}
	_ = driver.Stop(context.Background())
	select {
	case err := <-serverDone:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("MC server did not receive read and write")
	}
}
