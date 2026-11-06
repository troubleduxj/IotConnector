package acquisition

import (
	"context"
	"os"
	"strconv"
	"testing"
	"time"
)

func TestS7ProtoForgeReadWrite(t *testing.T) {
	if os.Getenv("PROTOFORGE_S7") != "1" {
		t.Skip("set PROTOFORGE_S7=1 to run the live ProtoForge S7 check")
	}
	host := os.Getenv("PROTOFORGE_S7_HOST")
	if host == "" {
		host = "127.0.0.1"
	}
	port := 103
	if raw := os.Getenv("PROTOFORGE_S7_PORT"); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil || parsed < 1 || parsed > 65535 {
			t.Fatalf("invalid PROTOFORGE_S7_PORT %q", raw)
		}
		port = parsed
	}
	driver := newS7Driver(
		Channel{ID: "s7-live", Protocol: "Siemens Profinet", Host: host, Port: port, Params: map[string]any{"rack": 0, "slot": 1}},
		[]Tag{
			{ID: "dbd0", Address: "DB1.DBD0", DataType: "Int32"},
			{ID: "dbb4", Address: "DB1.DBB4", DataType: "Byte"},
			{ID: "m00", Address: "M0.0", DataType: "Bool"},
			{ID: "q00", Address: "Q0.0", DataType: "Bool"},
		},
		func(Sample) {}, func(ChannelStatus) {},
	).(*s7Driver)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	read, err := driver.Read(ctx, driver.tags)
	if err != nil {
		t.Fatal(err)
	}
	if len(read) != 4 || read[0].Value.Number == nil || read[1].Value.Number == nil || read[2].Value.Bool == nil || read[3].Value.Bool == nil {
		t.Fatalf("unexpected S7 read: %#v", read)
	}
	if err := driver.Write(ctx, driver.tags[0], NumberValue(*read[0].Value.Number)); err != nil {
		t.Fatal(err)
	}
	if err := driver.Write(ctx, driver.tags[2], BoolValue(*read[2].Value.Bool)); err != nil {
		t.Fatal(err)
	}
	if err := driver.Write(ctx, driver.tags[3], BoolValue(*read[3].Value.Bool)); err != nil {
		t.Fatal(err)
	}
	_ = driver.Stop(context.Background())
}
