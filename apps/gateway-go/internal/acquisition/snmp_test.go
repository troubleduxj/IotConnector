package acquisition

import (
	"testing"

	"github.com/gosnmp/gosnmp"
)

func TestConvertSNMPValue(t *testing.T) {
	value, quality := convertSNMPValue(gosnmp.SnmpPDU{Type: gosnmp.Integer, Value: int32(42)})
	if quality != QualityGood || value.Number == nil || *value.Number != 42 {
		t.Fatalf("unexpected integer: %#v quality=%s", value, quality)
	}
	value, quality = convertSNMPValue(gosnmp.SnmpPDU{Type: gosnmp.OctetString, Value: []byte("12.5")})
	if quality != QualityGood || value.Number == nil || *value.Number != 12.5 {
		t.Fatalf("unexpected numeric string: %#v quality=%s", value, quality)
	}
	value, quality = convertSNMPValue(gosnmp.SnmpPDU{Type: gosnmp.NoSuchObject, Value: nil})
	if quality != QualityUncertain || value.Number == nil {
		t.Fatalf("unexpected missing value: %#v quality=%s", value, quality)
	}
}
