package acquisition

import (
	"net"
	"strings"
	"testing"
	"time"
)

func TestCapturedConnRecordsTXAndRX(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	go func() {
		conn, err := listener.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		buf := make([]byte, 16)
		n, _ := conn.Read(buf)
		_, _ = conn.Write(append([]byte{0xAA}, buf[:n]...))
	}()
	id := "cap-test"
	ClearFrames(id)
	conn, err := dialCaptured(id, "tcp", listener.Addr().String(), time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	if _, err := conn.Write([]byte{0x01, 0x02}); err != nil {
		t.Fatal(err)
	}
	reply := make([]byte, 3)
	_ = conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	if _, err := conn.Read(reply); err != nil {
		t.Fatal(err)
	}
	frames := Frames(id, 10, "")
	if len(frames) != 2 || frames[0].Dir != "RX" || frames[0].Hex != "aa0102" || frames[1].Dir != "TX" || frames[1].Hex != "0102" {
		t.Fatalf("frames = %+v", frames)
	}
	if tx := Frames(id, 10, "TX"); len(tx) != 1 {
		t.Fatalf("dir filter: %+v", tx)
	}
	ClearFrames(id)
	if len(Frames(id, 10, "")) != 0 {
		t.Fatal("clear did not empty ring")
	}
}

func TestFrameRingWrapsAndTruncates(t *testing.T) {
	id := "ring-test"
	ClearFrames(id)
	for i := 0; i < frameRingSize+5; i++ {
		recordFrame(id, "TX", []byte{byte(i)})
	}
	frames := Frames(id, 1000, "")
	if len(frames) != frameRingSize || frames[0].Hex != "cc" { // 最后一帧 i=204=0xcc，新的在前
		t.Fatalf("len=%d first=%s", len(frames), frames[0].Hex)
	}
	recordFrame(id, "RX", []byte(strings.Repeat("x", frameMaxBytes+10)))
	big := Frames(id, 1, "RX")[0]
	if big.Bytes != frameMaxBytes+10 || big.Note != "truncated" || len(big.Hex) != frameMaxBytes*2 {
		t.Fatalf("truncation: bytes=%d note=%q hexlen=%d", big.Bytes, big.Note, len(big.Hex))
	}
}
