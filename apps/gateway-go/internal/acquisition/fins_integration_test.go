package acquisition

import (
	"context"
	"os"
	"strconv"
	"testing"
	"time"
)

func TestFinsProtoForgeReadWrite(t *testing.T) {
	if os.Getenv("PROTOFORGE_FINS") != "1" {
		t.Skip("set PROTOFORGE_FINS=1 to run the live ProtoForge FINS check")
	}
	host := os.Getenv("PROTOFORGE_FINS_HOST")
	if host == "" {
		host = "127.0.0.1"
	}
	port := 19600
	if raw := os.Getenv("PROTOFORGE_FINS_PORT"); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil || parsed < 1 || parsed > 65535 {
			t.Fatalf("invalid PROTOFORGE_FINS_PORT %q", raw)
		}
		port = parsed
	}
	driver := newFinsDriver(
		Channel{ID: "fins-live", Protocol: "Omron FINS", Host: host, Port: port, Params: map[string]any{"sourceNode": 0, "destNode": 1, "destUnit": 0}},
		[]Tag{{ID: "dm0", Address: "D0", DataType: "Int16"}, {ID: "cio00", Address: "CIO0.00", DataType: "Bool"}},
		func(Sample) {}, func(ChannelStatus) {},
	).(*finsDriver)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	read, err := driver.Read(ctx, driver.tags)
	if err != nil {
		t.Fatal(err)
	}
	if len(read) != 2 || read[0].Value.Number == nil || read[1].Value.Bool == nil {
		t.Fatalf("unexpected FINS read: %#v", read)
	}
	if err := driver.Write(ctx, driver.tags[0], NumberValue(*read[0].Value.Number)); err != nil {
		t.Fatal(err)
	}
	if err := driver.Write(ctx, driver.tags[1], BoolValue(*read[1].Value.Bool)); err != nil {
		t.Fatal(err)
	}
	_ = driver.Stop(context.Background())
}
