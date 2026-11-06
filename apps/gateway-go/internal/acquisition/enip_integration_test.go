package acquisition

import (
	"context"
	"os"
	"strconv"
	"testing"
	"time"
)

func TestEnipProtoForgeReadWrite(t *testing.T) {
	if os.Getenv("PROTOFORGE_ENIP") != "1" {
		t.Skip("set PROTOFORGE_ENIP=1 to run the live ProtoForge EtherNet/IP check")
	}
	host := os.Getenv("PROTOFORGE_ENIP_HOST")
	if host == "" {
		host = "127.0.0.1"
	}
	port := 14448
	if raw := os.Getenv("PROTOFORGE_ENIP_PORT"); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil || parsed < 1 || parsed > 65535 {
			t.Fatalf("invalid PROTOFORGE_ENIP_PORT %q", raw)
		}
		port = parsed
	}
	driver := newEnipDriver(
		Channel{ID: "enip-live", Protocol: "EtherNet/IP (Rockwell)", Host: host, Port: port, Params: map[string]any{"slot": 0}},
		[]Tag{{ID: "temperature", Address: "Temperature", DataType: "Float"}, {ID: "counter", Address: "Counter", DataType: "Int16"}},
		func(Sample) {}, func(ChannelStatus) {},
	).(*enipDriver)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	read, err := driver.Read(ctx, driver.tags)
	if err != nil {
		t.Fatal(err)
	}
	if len(read) != 2 || read[0].Value.Number == nil || read[1].Value.Number == nil {
		t.Fatalf("unexpected EtherNet/IP read: %#v", read)
	}
	if err := driver.Write(ctx, driver.tags[0], NumberValue(*read[0].Value.Number)); err != nil {
		t.Fatal(err)
	}
	if err := driver.Write(ctx, driver.tags[1], NumberValue(*read[1].Value.Number)); err != nil {
		t.Fatal(err)
	}
	_ = driver.Stop(context.Background())
}
