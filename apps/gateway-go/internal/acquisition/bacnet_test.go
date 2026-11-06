package acquisition

import (
	"context"
	"encoding/binary"
	"net"
	"testing"
	"time"
)

func TestBACnetRPMDecodeProtoForgeShape(t *testing.T) {
	// BVLC(4)+NPDU(2)+APDU(4), followed by ProtoForge's compact RPM list.
	packet := []byte{0x81, 0x0a, 0, 0, 0x01, 0x00, 0x05, 0x0e}
	packet = append(packet, encodeObjectID(0, 1)...)
	packet = append(packet, 1, bacnetPresentValue, 0x44, 0x41, 0x48, 0x00, 0x00)
	packet = append(packet, encodeObjectID(3, 2)...)
	packet = append(packet, 1, bacnetPresentValue, 0x19, 1)
	var f uint32 = 0x41480000
	_ = f
	value, err := parseBACnetRPM(packet, []bacnetBinding{{tag: Tag{ID: "temp", DataType: "Float"}, objectType: 0, instance: 1}, {tag: Tag{ID: "run", DataType: "Bool"}, objectType: 3, instance: 2}})
	if err != nil {
		t.Fatal(err)
	}
	if value["temp"].Number == nil || *value["temp"].Number != 12.5 {
		t.Fatalf("unexpected temp: %#v", value["temp"])
	}
	if value["run"].Bool == nil || !*value["run"].Bool {
		t.Fatalf("unexpected run: %#v", value["run"])
	}
}

func TestBACnetStopUnblocksPendingRequest(t *testing.T) {
	probe, err := net.ListenUDP("udp4", &net.UDPAddr{IP: net.IPv4zero, Port: 0})
	if err != nil {
		t.Fatal(err)
	}
	port := probe.LocalAddr().(*net.UDPAddr).Port
	_ = probe.Close()
	driver := newBACnetDriver(
		Channel{ID: "bacnet-stop", Protocol: "BACnet/IP", Host: "127.0.0.1", Port: port, PollIntervalMs: 500},
		[]Tag{{ID: "ai1", Address: "AI:1", DataType: "Float"}}, func(Sample) {}, func(ChannelStatus) {},
	).(*bacnetDriver)
	readDone := make(chan struct{})
	go func() {
		_, _ = driver.Read(context.Background(), driver.tags)
		close(readDone)
	}()
	time.Sleep(50 * time.Millisecond)
	stopCtx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := driver.Stop(stopCtx); err != nil {
		t.Fatal(err)
	}
	select {
	case <-readDone:
	case <-time.After(time.Second):
		t.Fatal("pending BACnet request was not unblocked by Stop")
	}
}

func TestBACnetTimeoutThenRecoveryOnSameSocket(t *testing.T) {
	server, err := net.ListenUDP("udp4", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1), Port: 0})
	if err != nil {
		t.Fatal(err)
	}
	defer server.Close()
	driver := newBACnetDriver(
		Channel{ID: "bacnet-recovery", Protocol: "BACnet/IP", Host: "127.0.0.1", Port: server.LocalAddr().(*net.UDPAddr).Port},
		[]Tag{{ID: "ai1", Address: "AI:1", DataType: "Float"}}, func(Sample) {}, func(ChannelStatus) {},
	).(*bacnetDriver)
	requests := make(chan []byte, 2)
	go func() {
		buf := make([]byte, 2048)
		for i := 0; i < 2; i++ {
			n, addr, readErr := server.ReadFromUDP(buf)
			if readErr != nil {
				return
			}
			requests <- append([]byte(nil), buf[:n]...)
			if i == 1 {
				request := buf[:n]
				invoke := request[8]
				response := []byte{0x81, 0x0a, 0, 0, 0x01, 0x00, 0x30, invoke, 0x00, 0x0e,
					0x0c, 0x00, 0x00, 0x00, 0x01, 0x1e, 0x29, 0x55, 0x4e, 0x44, 0x41, 0x48, 0x00, 0x00, 0x4f, 0x1f}
				response[2] = byte(len(response) >> 8)
				response[3] = byte(len(response))
				_, _ = server.WriteToUDP(response, addr)
			}
		}
	}()
	firstCtx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	if _, err := driver.Read(firstCtx, driver.tags); err == nil {
		t.Fatal("expected first BACnet request to time out")
	}
	select {
	case <-requests:
	case <-time.After(time.Second):
		t.Fatal("server did not receive first BACnet request")
	}
	secondCtx, cancelSecond := context.WithTimeout(context.Background(), time.Second)
	defer cancelSecond()
	read, err := driver.Read(secondCtx, driver.tags)
	if err != nil {
		t.Fatal(err)
	}
	if len(read) != 1 || read[0].Value.Number == nil || *read[0].Value.Number != 12.5 {
		t.Fatalf("unexpected recovered BACnet read: %#v", read)
	}
	_ = driver.Stop(context.Background())
}

func TestBACnetAddressAndWriteEncoding(t *testing.T) {
	d := &bacnetDriver{}
	b, err := d.bindingFor(Tag{Address: "av:3"})
	if err != nil || b.objectType != 2 || b.instance != 3 {
		t.Fatalf("binding: %#v %v", b, err)
	}
	value, err := bacnetRawValue(NumberValue(12.5), "Float")
	if err != nil || len(value) != 5 || value[0] != 0x44 || binary.BigEndian.Uint32(value[1:]) != 0x41480000 {
		t.Fatalf("encoding: %x %v", value, err)
	}
}

func TestBACnetRPMDecodeStandardShape(t *testing.T) {
	// BVLC + NPDU + Complex-ACK followed by a standard ReadAccessResult.
	packet := []byte{0x81, 0x0a, 0, 0, 0x01, 0x00, 0x30, 0x07, 0x00, 0x0e}
	packet = append(packet, 0x0c)
	packet = append(packet, encodeObjectID(0, 1)...)
	packet = append(packet, 0x1e, 0x29, bacnetPresentValue, 0x4e, 0x44, 0x41, 0x48, 0x00, 0x00, 0x4f, 0x1f)
	value, err := parseBACnetRPM(packet, []bacnetBinding{{tag: Tag{ID: "temp", DataType: "Float"}, objectType: 0, instance: 1}})
	if err != nil {
		t.Fatal(err)
	}
	if value["temp"].Number == nil || *value["temp"].Number != 12.5 {
		t.Fatalf("unexpected standard RPM value: %#v", value)
	}
}
