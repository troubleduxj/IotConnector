package acquisition

import (
	"context"
	"os"
	"testing"
	"time"
)

func TestConvertOPCUAValue(t *testing.T) {
	value, err := convertOPCUAValue(float32(12.5), "Float")
	if err != nil || value.Number == nil || *value.Number != 12.5 {
		t.Fatalf("unexpected numeric value: %#v %v", value, err)
	}
	value, err = convertOPCUAValue(true, "Bool")
	if err != nil || value.Bool == nil || !*value.Bool {
		t.Fatalf("unexpected bool value: %#v %v", value, err)
	}
}

func TestOPCUAProtoForgeReadWrite(t *testing.T) {
	if os.Getenv("PROTOFORGE_OPCUA") != "1" {
		t.Skip("set PROTOFORGE_OPCUA=1 to run the live ProtoForge OPC UA check")
	}
	driver := newOPCUADriver(
		Channel{ID: "opc-01", Protocol: "OPC UA", Host: "127.0.0.1", Port: 4840, Params: map[string]any{
			"endpointUrl": "opc.tcp://127.0.0.1:4840", "securityMode": "None", "securityPolicy": "None", "authType": "Anonymous",
		}},
		[]Tag{{ID: "tag-8", Address: "ns=2;i=2", DataType: "Float"}},
		func(Sample) {}, func(ChannelStatus) {},
	).(*opcuaDriver)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	read, err := driver.Read(ctx, driver.tags)
	if err != nil { t.Fatal(err) }
	if len(read) != 1 || read[0].Value.Number == nil { t.Fatalf("unexpected OPC UA read: %#v", read) }
	if err := driver.Write(ctx, driver.tags[0], NumberValue(*read[0].Value.Number)); err != nil { t.Fatal(err) }
	_ = driver.Stop(context.Background())
}
