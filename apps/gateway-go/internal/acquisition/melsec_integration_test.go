package acquisition

import (
	"context"
	"os"
	"strconv"
	"testing"
	"time"
)

func TestMelsecProtoForgeReadWrite(t *testing.T) {
	if os.Getenv("PROTOFORGE_MELSEC") != "1" {
		t.Skip("set PROTOFORGE_MELSEC=1 to run the live ProtoForge MELSEC check")
	}
	host := os.Getenv("PROTOFORGE_MELSEC_HOST")
	if host == "" {
		host = "127.0.0.1"
	}
	port := 11021
	if raw := os.Getenv("PROTOFORGE_MELSEC_PORT"); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil || parsed < 1 || parsed > 65535 {
			t.Fatalf("invalid PROTOFORGE_MELSEC_PORT %q", raw)
		}
		port = parsed
	}
	driver := newMelsecDriver(
		Channel{ID: "mc-live", Protocol: "Mitsubishi MELSEC", Host: host, Port: port},
		[]Tag{{ID: "d100", Address: "D100", DataType: "Int16"}, {ID: "m0", Address: "M0", DataType: "Bool"}},
		func(Sample) {}, func(ChannelStatus) {},
	).(*melsecDriver)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	read, err := driver.Read(ctx, driver.tags)
	if err != nil {
		t.Fatal(err)
	}
	if len(read) != 2 || read[0].Value.Number == nil || read[1].Value.Bool == nil {
		t.Fatalf("unexpected MELSEC read: %#v", read)
	}
	if err := driver.Write(ctx, driver.tags[0], NumberValue(*read[0].Value.Number)); err != nil {
		t.Fatal(err)
	}
	if err := driver.Write(ctx, driver.tags[1], BoolValue(*read[1].Value.Bool)); err != nil {
		t.Fatal(err)
	}
	_ = driver.Stop(context.Background())
}
