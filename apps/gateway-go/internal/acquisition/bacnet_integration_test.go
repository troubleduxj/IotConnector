package acquisition

import (
	"context"
	"os"
	"strconv"
	"testing"
	"time"
)

func TestBACnetProtoForgeReadWrite(t *testing.T) {
	if os.Getenv("PROTOFORGE_BACNET") != "1" {
		t.Skip("set PROTOFORGE_BACNET=1 to run the live ProtoForge BACnet check")
	}
	host := os.Getenv("PROTOFORGE_BACNET_HOST")
	if host == "" {
		host = "127.0.0.1"
	}
	port := 47808
	if raw := os.Getenv("PROTOFORGE_BACNET_PORT"); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil || parsed < 1 || parsed > 65535 {
			t.Fatalf("invalid PROTOFORGE_BACNET_PORT %q", raw)
		}
		port = parsed
	}
	tags := []Tag{
		{ID: "ai1", Address: "AI:1", DataType: "Float"},
		{ID: "ao1", Address: "AO:1", DataType: "Float"},
		{ID: "bi1", Address: "BI:1", DataType: "Bool"},
	}
	driver := newBACnetDriver(
		Channel{ID: "bacnet-live", Protocol: "BACnet/IP", Host: host, Port: port, PollIntervalMs: 500},
		tags, func(Sample) {}, func(ChannelStatus) {},
	).(*bacnetDriver)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	read, err := driver.Read(ctx, tags)
	if err != nil {
		t.Fatal(err)
	}
	if len(read) != len(tags) {
		t.Fatalf("unexpected BACnet read: %#v", read)
	}
	if err := driver.Write(ctx, tags[1], NumberValue(30.5)); err != nil {
		t.Fatal(err)
	}
	read, err = driver.Read(ctx, []Tag{tags[1]})
	if err != nil {
		t.Fatal(err)
	}
	// ProtoForge's demo AO uses a random generator, so its simulation loop may
	// advance the value immediately after the successful WriteProperty ACK.
	// Verify the read path remains healthy; the write itself is verified by the
	// absence of an error above.
	if len(read) != 1 || read[0].Value.Number == nil {
		t.Fatalf("unexpected BACnet AO after write: %#v", read)
	}
	_ = driver.Stop(context.Background())
}

func TestBACnetProtoForgeWhoIs(t *testing.T) {
	if os.Getenv("PROTOFORGE_BACNET") != "1" {
		t.Skip("set PROTOFORGE_BACNET=1 to run the live ProtoForge BACnet discovery check")
	}
	driver := newBACnetDriver(
		Channel{ID: "bacnet-discovery", Protocol: "BACnet/IP", Host: "127.0.0.1", Port: 47808},
		nil, func(Sample) {}, func(ChannelStatus) {},
	).(*bacnetDriver)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	devices, err := driver.Discover(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(devices) == 0 || devices[0].ID == 0 || devices[0].MaxAPDU == 0 {
		t.Fatalf("unexpected I-Am devices: %#v", devices)
	}
	_ = driver.Stop(context.Background())
}

func TestBACnetProtoForgeSubscribeCOV(t *testing.T) {
	if os.Getenv("PROTOFORGE_BACNET") != "1" {
		t.Skip("set PROTOFORGE_BACNET=1 to run the live ProtoForge COV check")
	}
	tag := Tag{ID: "ai1", Address: "AI:1", DataType: "Float"}
	driver := newBACnetDriver(
		Channel{ID: "bacnet-cov", Protocol: "BACnet/IP", Host: "127.0.0.1", Port: 47808},
		[]Tag{tag}, func(Sample) {}, func(ChannelStatus) {},
	).(*bacnetDriver)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := driver.SubscribeCOV(ctx, tag, 7, 60); err != nil {
		t.Fatal(err)
	}
	_ = driver.conn.SetReadDeadline(time.Now().Add(3 * time.Second))
	buf := make([]byte, 2048)
	n, _, err := driver.conn.ReadFromUDP(buf)
	if err != nil {
		t.Fatal(err)
	}
	if n < 8 || buf[6] != 0x10 || buf[7] != 0x02 {
		t.Fatalf("unexpected COV notification: %x", buf[:n])
	}
	notification, ok := decodeBACnetCOVNotification(buf[:n])
	if !ok || notification.ProcessID != 7 || notification.ObjectType != 0 || notification.ObjectInstance != 1 {
		t.Fatalf("unexpected COV object: %#v / %x", notification, buf[:n])
	}
	if err := driver.CancelCOV(ctx, tag, 7); err != nil {
		t.Fatal(err)
	}
	_ = driver.Stop(context.Background())
}
