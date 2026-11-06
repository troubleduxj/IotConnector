package acquisition

import (
	"context"
	"encoding/binary"
	"io"
	"net"
	"testing"
	"time"
)

func TestParseFINSAddress(t *testing.T) {
	word, err := parseFINSAddress("D100")
	if err != nil || word.area != 0x82 || word.word != 100 || word.isBit {
		t.Fatalf("unexpected word address: %#v %v", word, err)
	}
	bit, err := parseFINSAddress("CIO5.03")
	if err != nil || bit.area != 0x30 || bit.word != 5 || bit.bit != 3 || !bit.isBit {
		t.Fatalf("unexpected bit address: %#v %v", bit, err)
	}
	if _, err := parseFINSAddress("D100.1"); err == nil {
		t.Fatal("expected non-CIO bit address to fail")
	}
}

func TestFinsTCPFrameLayout(t *testing.T) {
	address, _ := parseFINSAddress("D0")
	frame := finsReadWords(address, 1)
	if len(frame) != 33 || string(frame[:4]) != "FINS" {
		t.Fatalf("unexpected FINS frame length/header: len=%d frame=%x", len(frame), frame)
	}
	if frame[8] != 0 || frame[9] != 0 || frame[10] != 0 || frame[11] != 2 || frame[12] != 0 || frame[13] != 0 || frame[14] != 0 || frame[15] != 0 {
		t.Fatalf("unexpected FINS/TCP command prefix: %x", frame[8:16])
	}
	if frame[31] != 0 || frame[32] != 1 {
		t.Fatalf("unexpected word count: %x", frame[31:33])
	}
}

func TestFinsDriverReadsAndWritesFinsTCP(t *testing.T) {
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
			header := make([]byte, 8)
			if _, err := io.ReadFull(conn, header); err != nil {
				serverDone <- err
				return
			}
			payload := make([]byte, int(binary.BigEndian.Uint32(header[4:8])))
			if _, err := io.ReadFull(conn, payload); err != nil {
				serverDone <- err
				return
			}
			responseData := []byte{0x00, 0x00, 0x00, 0x00}
			if i == 0 {
				responseData[3] = 0x2A
			}
			responsePayload := append([]byte{0x00, 0x00, 0x00, 0x02, 0x00, 0x00, 0x00, 0x00}, finsHeader()...)
			responsePayload = append(responsePayload, 0x01, 0x01)
			responsePayload = append(responsePayload, responseData...)
			response := make([]byte, 8)
			copy(response[:4], []byte("FINS"))
			binary.BigEndian.PutUint32(response[4:8], uint32(len(responsePayload)))
			response = append(response, responsePayload...)
			if _, err := conn.Write(response); err != nil {
				serverDone <- err
				return
			}
		}
		serverDone <- nil
	}()

	driver := newFinsDriver(
		Channel{ID: "fins-1", Host: "127.0.0.1", Port: listener.Addr().(*net.TCPAddr).Port, PollIntervalMs: 1000},
		[]Tag{{ID: "tag-1", Address: "D100", DataType: "Int16"}},
		func(Sample) {},
		func(ChannelStatus) {},
	).(*finsDriver)
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
		t.Fatal("FINS server did not receive read and write")
	}
}
