package acquisition

import "testing"

func TestIEC104InterrogationFrameRoundTrip(t *testing.T) {
	asdu := []byte{iecCic, 1, iecCotAct, 0, 1, 0, 0, 0, 0, 20}
	frame := encodeIECIFrame(asdu, 3, 7)
	decoded := decodeIECFrame(frame)
	if decoded.kind != 0 || decoded.sendSeq != 3 || decoded.recvSeq != 7 {
		t.Fatalf("unexpected APCI decode: %+v", decoded)
	}
	if decoded.typeID != iecCic || decoded.cot != iecCotAct {
		t.Fatalf("unexpected ASDU decode: %+v", decoded)
	}
}

func TestIEC104MeasurementAndStatusDecode(t *testing.T) {
	asdu := []byte{iecMMeNc, 1, iecCotInterr, 0, 1, 0, 42, 0, 0, 0x00, 0x00, 0x20, 0x41, 0}
	frame := decodeIECFrame(encodeIECIFrame(asdu, 1, 0))
	if len(frame.points) != 1 || frame.points[0].ioa != 42 {
		t.Fatalf("unexpected measurement points: %+v", frame.points)
	}
	if frame.points[0].value.Number == nil || *frame.points[0].value.Number != 10 {
		t.Fatalf("unexpected measurement value: %+v", frame.points[0].value)
	}
}
