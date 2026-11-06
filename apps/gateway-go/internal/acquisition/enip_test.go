package acquisition

import (
	"context"
	"encoding/binary"
	"io"
	"net"
	"testing"
	"time"
)

func TestCIPSymbolicReadResponse(t *testing.T) {
	rr := []byte{0xCC, 0x00, 0x00, 0x00, 0xC3, 0x02, 0x00, 0x2A, 0x00}
	body := make([]byte, 6)
	body = append(body, 0x02, 0x00)
	body = append(body, 0xA1, 0x00, 0x04, 0x00, 0, 0, 0, 0)
	body = append(body, 0xB1, 0x00, byte(len(rr)), 0x00)
	body = append(body, rr...)
	frame := enipEncap(0x006F, 123, body)
	data, typeCode, err := parseCIPReadResponse(frame)
	if err != nil || typeCode != 0xC3 || len(data) != 2 || binary.LittleEndian.Uint16(data) != 42 {
		t.Fatalf("unexpected CIP response: data=%x type=0x%x err=%v", data, typeCode, err)
	}
}

func TestEnipDefaultRouteUsesSlotOne(t *testing.T) {
	if got := (&enipDriver{channel: Channel{Params: map[string]any{}}}).slot(); got != 1 {
		t.Fatalf("default EtherNet/IP slot = %d, want 1", got)
	}
	if got := (&enipDriver{channel: Channel{Params: map[string]any{"slot": float64(0)}}}).slot(); got != 0 {
		t.Fatalf("explicit EtherNet/IP slot = %d, want 0", got)
	}
}

func TestEnipDriverRegisterAndRead(t *testing.T) {
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
			header := make([]byte, 24)
			if _, err := io.ReadFull(conn, header); err != nil {
				serverDone <- err
				return
			}
			body := make([]byte, int(binary.LittleEndian.Uint16(header[2:4])))
			if _, err := io.ReadFull(conn, body); err != nil {
				serverDone <- err
				return
			}
			if i == 0 {
				response := enipEncap(0x0065, 123, nil)
				if _, err := conn.Write(response); err != nil {
					serverDone <- err
					return
				}
				continue
			}
			rr := []byte{0xCC, 0x00, 0x00, 0x00, 0xC3, 0x02, 0x00, 0x2A, 0x00}
			responseBody := make([]byte, 6)
			responseBody = append(responseBody, 0x02, 0x00)
			responseBody = append(responseBody, 0xA1, 0x00, 0x04, 0x00, 0, 0, 0, 0)
			responseBody = append(responseBody, 0xB1, 0x00, byte(len(rr)), 0x00)
			responseBody = append(responseBody, rr...)
			if _, err := conn.Write(enipEncap(0x006F, 123, responseBody)); err != nil {
				serverDone <- err
				return
			}
		}
		serverDone <- nil
	}()

	driver := newEnipDriver(
		Channel{ID: "enip-1", Host: "127.0.0.1", Port: listener.Addr().(*net.TCPAddr).Port, Params: map[string]any{"slot": float64(0)}},
		[]Tag{{ID: "tag-1", Address: "Line1.Speed", DataType: "Int16"}},
		func(Sample) {}, func(ChannelStatus) {},
	).(*enipDriver)
	read, err := driver.Read(context.Background(), driver.tags)
	if err != nil {
		t.Fatal(err)
	}
	if len(read) != 1 || read[0].Value.Number == nil || *read[0].Value.Number != 42 {
		t.Fatalf("unexpected read: %#v", read)
	}
	_ = driver.Stop(context.Background())
	select {
	case err := <-serverDone:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("EtherNet/IP server did not receive register and read")
	}
}
