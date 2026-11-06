package acquisition

import "testing"

func TestParseModbusAddress(t *testing.T) {
	tests := []struct {
		address  string
		function byte
		offset   uint16
	}{
		{"00001", 1, 0},
		{"10001", 2, 0},
		{"30011", 4, 10},
		{"40001", 3, 0},
		{"40125", 3, 124},
	}
	for _, test := range tests {
		got, err := parseModbusAddress(test.address)
		if err != nil {
			t.Fatalf("parse %s: %v", test.address, err)
		}
		if got.function != test.function || got.offset != test.offset {
			t.Fatalf("parse %s = %#v, want function=%d offset=%d", test.address, got, test.function, test.offset)
		}
	}
	if _, err := parseModbusAddress("DB1.Real0"); err == nil {
		t.Fatal("expected invalid address error")
	}
}

func TestDecodeModbusValues(t *testing.T) {
	got, err := decodeModbusValue([]byte{0x04, 0xD2}, "Int16", "CDAB")
	if err != nil || got.Number == nil || *got.Number != 1234 {
		t.Fatalf("Int16 decode: %#v, %v", got, err)
	}
	// Logical 12.5 = 0x41480000, wire order CDAB is 00 00 41 48.
	got, err = decodeModbusValue([]byte{0x00, 0x00, 0x41, 0x48}, "Float", "CDAB")
	if err != nil || got.Number == nil || *got.Number != 12.5 {
		t.Fatalf("Float decode: %#v, %v", got, err)
	}
	got, err = decodeModbusValue([]byte{0, 1}, "Bool", "ABCD")
	if err != nil || got.Bool == nil || !*got.Bool {
		t.Fatalf("Bool decode: %#v, %v", got, err)
	}
}

func TestWireBytesMatchesDecodeOrder(t *testing.T) {
	logical := []byte{0x41, 0x48, 0x00, 0x00} // Float32 12.5
	for _, order := range []string{"ABCD", "CDAB", "BADC", "DCBA"} {
		wire := wireBytes(logical, order)
		decoded := logicalBytes(wire, order)
		for i := range logical {
			if decoded[i] != logical[i] {
				t.Fatalf("order %s round trip = %x, want %x", order, decoded, logical)
			}
		}
	}
}
