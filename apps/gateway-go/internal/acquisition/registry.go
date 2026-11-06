package acquisition

import "os"

// NewFactory returns the protocol registry. Real drivers are opt-in through
// channel.params.driver so Node and Go can share one configuration during migration.
func NewFactory() DriverFactory {
	return func(channel Channel, tags []Tag, publish func(Sample), setStatus func(ChannelStatus)) Driver {
		requested, _ := channel.Params["driver"].(string)
		// GATEWAY_GO_DRIVER_MODE=go enables transparent Go routing for protocols
		// already covered by Go. Explicit params.driver always wins, preserving
		// per-channel rollout and rollback during the Node migration.
		if os.Getenv("GATEWAY_GO_DRIVER_MODE") == "go" && requested == "" {
			switch channel.Protocol {
			case "Modbus TCP":
				requested = "modbus-go"
			case "Siemens Profinet":
				requested = "s7-go"
			case "Mitsubishi MELSEC":
				requested = "melsec-go"
			case "Omron FINS":
				requested = "fins-go"
			case "EtherNet/IP (Rockwell)":
				requested = "enip-go"
			case "SNMP":
				requested = "snmp-go"
			case "OPC UA":
				requested = "opcua-go"
			case "BACnet/IP":
				requested = "bacnet-go"
			case "MQTT / Sparkplug B":
				requested = "mqtt-go"
			case "IEC 60870-5-104":
				requested = "iec104-go"
			}
		}
		if requested == "simulation" {
			return newSimulationDriver(channel, tags, publish, setStatus)
		}
		if requested == "modbus-go" && channel.Protocol == "Modbus TCP" {
			return newModbusDriver(channel, tags, publish, setStatus)
		}
		if requested == "melsec-go" && channel.Protocol == "Mitsubishi MELSEC" {
			return newMelsecDriver(channel, tags, publish, setStatus)
		}
		if requested == "fins-go" && channel.Protocol == "Omron FINS" {
			return newFinsDriver(channel, tags, publish, setStatus)
		}
		if requested == "enip-go" && channel.Protocol == "EtherNet/IP (Rockwell)" {
			return newEnipDriver(channel, tags, publish, setStatus)
		}
		if requested == "snmp-go" && channel.Protocol == "SNMP" {
			return newSNMPDriver(channel, tags, publish, setStatus)
		}
		if requested == "opcua-go" && channel.Protocol == "OPC UA" {
			return newOPCUADriver(channel, tags, publish, setStatus)
		}
		if requested == "bacnet-go" && channel.Protocol == "BACnet/IP" {
			return newBACnetDriver(channel, tags, publish, setStatus)
		}
		if requested == "mqtt-go" && channel.Protocol == "MQTT / Sparkplug B" {
			return newMQTTDriver(channel, tags, publish, setStatus)
		}
		if requested == "iec104-go" && channel.Protocol == "IEC 60870-5-104" {
			return newIEC104Driver(channel, tags, publish, setStatus)
		}
		if requested == "s7-go" && channel.Protocol == "Siemens Profinet" {
			return newS7Driver(channel, tags, publish, setStatus)
		}
		return nil
	}
}
