package acquisition

import (
	"context"
	"io"
	"log"
	"net"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/gosnmp/gosnmp"
)

func TestSNMPDriverExternalAgent(t *testing.T) {
	if os.Getenv("SNMP_EXTERNAL_TEST") != "1" {
		t.Skip("set SNMP_EXTERNAL_TEST=1 to run against a standard SNMP agent")
	}
	host := os.Getenv("SNMP_EXTERNAL_HOST")
	if host == "" {
		host = "127.0.0.1"
	}
	port := 1161
	if value := os.Getenv("SNMP_EXTERNAL_PORT"); value != "" {
		parsed, err := strconv.Atoi(value)
		if err != nil {
			t.Fatal(err)
		}
		port = parsed
	}
	version := os.Getenv("SNMP_EXTERNAL_VERSION")
	if version == "" {
		version = "2"
	}
	community := os.Getenv("SNMP_EXTERNAL_COMMUNITY")
	if community == "" {
		community = "public"
	}
	channel := Channel{ID: "snmp-external", Host: host, Port: port, Params: map[string]any{"community": community, "snmpVersion": version, "timeoutMs": 500, "retries": 1}}
	driver := newSNMPDriver(channel, nil, func(Sample) {}, func(ChannelStatus) {}).(*snmpDriver)
	tags := []Tag{
		{ID: "voltage", Address: "1.3.6.1.4.1.99999.1.1.0", DataType: "Int16"},
		{ID: "battery", Address: ".1.3.6.1.4.1.99999.1.2.0", DataType: "UInt16"},
		{ID: "location", Address: "1.3.6.1.4.1.99999.1.3.0", DataType: "String"},
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	read, err := driver.Read(ctx, tags)
	if err != nil {
		t.Fatal(err)
	}
	if len(read) != len(tags) {
		t.Fatalf("expected %d samples, got %d", len(tags), len(read))
	}
	if read[0].Value.Number == nil || read[1].Value.Number == nil || read[2].Value.String == nil {
		t.Fatalf("unexpected external values: %#v", read)
	}
	if err := driver.Write(ctx, tags[0], NumberValue(230)); err != nil {
		t.Fatal(err)
	}
	_ = driver.Stop(context.Background())

	dead := newSNMPDriver(Channel{ID: "snmp-timeout", Host: host, Port: port + 1, Params: map[string]any{"community": "public", "snmpVersion": version, "timeoutMs": 100, "retries": 1}}, nil, func(Sample) {}, func(ChannelStatus) {}).(*snmpDriver)
	timeoutCtx, timeoutCancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer timeoutCancel()
	if _, err := dead.Read(timeoutCtx, tags[:1]); err == nil {
		t.Fatal("expected timeout against unavailable SNMP endpoint")
	}
}

func TestSNMPAgentRejectsCommunity(t *testing.T) {
	if os.Getenv("SNMP_EXTERNAL_REJECT_TEST") != "1" {
		t.Skip("set SNMP_EXTERNAL_REJECT_TEST=1 to verify community rejection")
	}
	host := os.Getenv("SNMP_EXTERNAL_HOST")
	if host == "" {
		host = "127.0.0.1"
	}
	port := 1161
	if value := os.Getenv("SNMP_EXTERNAL_PORT"); value != "" {
		parsed, err := strconv.Atoi(value)
		if err != nil {
			t.Fatal(err)
		}
		port = parsed
	}
	channel := Channel{ID: "snmp-rejected", Host: host, Port: port, Params: map[string]any{"community": "incorrect", "snmpVersion": "2", "timeoutMs": 150, "retries": 0}}
	driver := newSNMPDriver(channel, nil, func(Sample) {}, func(ChannelStatus) {}).(*snmpDriver)
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if _, err := driver.Read(ctx, []Tag{{ID: "voltage", Address: "1.3.6.1.4.1.99999.1.1.0", DataType: "Int16"}}); err == nil {
		t.Fatal("expected rejected community request to time out")
	}
}

func TestSNMPDriverUDPv2cReadWrite(t *testing.T) {
	conn, err := net.ListenUDP("udp4", &net.UDPAddr{IP: net.ParseIP("127.0.0.1")})
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()

	values := map[string]gosnmp.SnmpPDU{
		"1.3.6.1.4.1.53864.1.1.0": {Name: "1.3.6.1.4.1.53864.1.1.0", Type: gosnmp.Integer, Value: 42},
		"1.3.6.1.4.1.53864.1.2.0": {Name: "1.3.6.1.4.1.53864.1.2.0", Type: gosnmp.OctetString, Value: []byte("12.5")},
	}
	serverErr := make(chan error, 1)
	go func() {
		decoder := &gosnmp.GoSNMP{Logger: gosnmp.NewLogger(log.New(io.Discard, "", 0))}
		packet := make([]byte, 4096)
		for requestNo := 0; requestNo < 3; requestNo++ {
			n, addr, readErr := conn.ReadFromUDP(packet)
			if readErr != nil {
				serverErr <- readErr
				return
			}
			request, decodeErr := decoder.SnmpDecodePacket(packet[:n])
			if decodeErr != nil {
				serverErr <- decodeErr
				return
			}
			responseVariables := make([]gosnmp.SnmpPDU, 0, len(request.Variables))
			for _, variable := range request.Variables {
				oid := strings.TrimPrefix(variable.Name, ".")
				value, ok := values[oid]
				if !ok {
					value = gosnmp.SnmpPDU{Name: variable.Name, Type: gosnmp.NoSuchObject}
				}
				value.Name = variable.Name
				responseVariables = append(responseVariables, value)
			}
			response := &gosnmp.SnmpPacket{
				Version:   gosnmp.Version2c,
				Community: request.Community,
			}
			response = (&gosnmp.GoSNMP{Version: gosnmp.Version2c, Community: request.Community}).MkSnmpPacket(gosnmp.GetResponse, responseVariables, 0, 0)
			response.RequestID = request.RequestID
			encoded, marshalErr := response.MarshalMsg()
			if marshalErr != nil {
				serverErr <- marshalErr
				return
			}
			if _, writeErr := conn.WriteToUDP(encoded, addr); writeErr != nil {
				serverErr <- writeErr
				return
			}
		}
		serverErr <- nil
	}()

	driver := newSNMPDriver(
		Channel{ID: "snmp-live", Host: "127.0.0.1", Port: conn.LocalAddr().(*net.UDPAddr).Port, Params: map[string]any{"community": "public", "snmpVersion": "2"}},
		[]Tag{{ID: "counter", Address: "1.3.6.1.4.1.53864.1.1.0", DataType: "Int16"}, {ID: "text", Address: "1.3.6.1.4.1.53864.1.2.0", DataType: "String"}},
		func(Sample) {}, func(ChannelStatus) {},
	).(*snmpDriver)

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	read, err := driver.Read(ctx, driver.tags)
	if err != nil {
		select {
		case serverErr := <-serverErr:
			t.Fatalf("SNMP test server: %v (driver: %v)", serverErr, err)
		default:
		}
		t.Fatal(err)
	}
	if len(read) != 2 || read[0].Value.Number == nil || *read[0].Value.Number != 42 || read[1].Value.Number == nil || *read[1].Value.Number != 12.5 {
		t.Fatalf("unexpected SNMP read: %#v", read)
	}
	if err := driver.Write(ctx, driver.tags[0], NumberValue(77)); err != nil {
		t.Fatal(err)
	}
	if err := driver.Write(ctx, driver.tags[1], StringValue("ok")); err != nil {
		t.Fatal(err)
	}
	_ = driver.Stop(context.Background())
	select {
	case err := <-serverErr:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("SNMP UDP server did not receive GET and SET requests")
	}
}
