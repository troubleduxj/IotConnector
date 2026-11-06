package acquisition

import (
	"reflect"
	"testing"
)

func TestFactoryGoModeRoutesCoveredProtocols(t *testing.T) {
	t.Setenv("GATEWAY_GO_DRIVER_MODE", "go")
	factory := NewFactory()
	cases := []struct {
		protocol string
		wantType string
	}{
		{"Modbus TCP", "*acquisition.modbusDriver"},
		{"Siemens Profinet", "*acquisition.s7Driver"},
		{"Mitsubishi MELSEC", "*acquisition.melsecDriver"},
		{"Omron FINS", "*acquisition.finsDriver"},
		{"EtherNet/IP (Rockwell)", "*acquisition.enipDriver"},
		{"SNMP", "*acquisition.snmpDriver"},
		{"OPC UA", "*acquisition.opcuaDriver"},
		{"BACnet/IP", "*acquisition.bacnetDriver"},
	}
	for _, tc := range cases {
		driver := factory(Channel{Protocol: tc.protocol, Params: map[string]any{}}, nil, func(Sample) {}, func(ChannelStatus) {})
		if driver == nil {
			t.Fatalf("%s did not route in Go mode", tc.protocol)
		}
		if got := reflect.TypeOf(driver).String(); got != tc.wantType {
			t.Fatalf("%s routed to %s, want %s", tc.protocol, got, tc.wantType)
		}
	}
}

func TestFactoryExplicitDriverTakesPrecedence(t *testing.T) {
	t.Setenv("GATEWAY_GO_DRIVER_MODE", "go")
	factory := NewFactory()
	driver := factory(Channel{Protocol: "BACnet/IP", Params: map[string]any{"driver": "bacnet-go"}}, nil, func(Sample) {}, func(ChannelStatus) {})
	if got := reflect.TypeOf(driver).String(); got != "*acquisition.bacnetDriver" {
		t.Fatalf("explicit Go driver routed to %s", got)
	}
	// An explicit Node/legacy value must not be silently replaced by the global
	// Go switch; the outer gateway can then retain the Node implementation.
	if fallback := factory(Channel{Protocol: "BACnet/IP", Params: map[string]any{"driver": "node"}}, nil, func(Sample) {}, func(ChannelStatus) {}); fallback != nil {
		t.Fatalf("explicit legacy driver was unexpectedly replaced: %T", fallback)
	}
}

func TestFactoryDoesNotRouteCoveredProtocolWithoutGoMode(t *testing.T) {
	t.Setenv("GATEWAY_GO_DRIVER_MODE", "")
	factory := NewFactory()
	if driver := factory(Channel{Protocol: "BACnet/IP", Params: map[string]any{}}, nil, func(Sample) {}, func(ChannelStatus) {}); driver != nil {
		t.Fatalf("BACnet was routed without Go mode: %T", driver)
	}
}
