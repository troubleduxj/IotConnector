package acquisition

import "testing"

func TestParseS7Address(t *testing.T) {
	tests := []struct {
		address string
		db      int
		off     int
		bit     uint
		kind    string
	}{
		{"DB1.DBX0.0", 1, 0, 0, "Bool"},
		{"db301.Real10", 301, 10, 0, "Float"},
		{"DB2.DInt2", 2, 2, 0, "Int32"},
		{"DB3.INT4", 3, 4, 0, "Int16"},
		{"DB4.WORD6", 4, 6, 0, "UInt16"},
		{"DB5.DWORD8", 5, 8, 0, "Int32"},
		{"DB6.DBB12", 6, 12, 0, "Byte"},
		{"DB7.CHAR14", 7, 14, 0, "Byte"},
		{"M0.0", 0, 0, 0, "Bool"},
		{"IB4", 0, 4, 0, "Byte"},
		{"QW6", 0, 6, 0, "Int16"},
		{"MD8", 0, 8, 0, "Int32"},
		{"T1", 0, 1, 0, "UInt16"},
		{"Z2", 0, 2, 0, "UInt16"},
	}
	for _, test := range tests {
		got, err := parseS7Address(test.address)
		if err != nil {
			t.Fatalf("parse %s: %v", test.address, err)
		}
		if got.db != test.db || got.off != test.off || got.bit != test.bit || got.kind != test.kind {
			t.Fatalf("parse %s = %#v, want db=%d off=%d bit=%d kind=%s", test.address, got, test.db, test.off, test.bit, test.kind)
		}
	}
}

func TestParseS7AddressRejectsInvalid(t *testing.T) {
	for _, address := range []string{"DB1.DBX0.8", "DB1.DBX0", "DB1.Unknown0", "DBx1.DBD0", "M0.8"} {
		if _, err := parseS7Address(address); err == nil {
			t.Fatalf("expected invalid S7 address %q", address)
		}
	}
}

func TestS7ValueSizes(t *testing.T) {
	tests := map[string]int{"Bool": 1, "Byte": 1, "Int16": 2, "UInt16": 2, "Int32": 4, "Float": 4}
	for kind, want := range tests {
		if got := s7ValueSize(kind); got != want {
			t.Errorf("size(%s) = %d, want %d", kind, got, want)
		}
	}
}

func TestS7MultiMapping(t *testing.T) {
	tests := []struct {
		address string
		wordLen int
		area    int
	}{
		{"DB1.DBD0", 0x07, 0x84},
		{"M0.0", 0x01, 0x83},
		{"IB0", 0x02, 0x81},
		{"QW2", 0x04, 0x82},
		{"T1", 0x1D, 0x1D},
		{"C1", 0x1C, 0x1C},
	}
	for _, test := range tests {
		address, err := parseS7Address(test.address)
		if err != nil {
			t.Fatalf("parse %s: %v", test.address, err)
		}
		wordLen, area, ok := s7MultiMapping(address)
		if !ok || wordLen != test.wordLen || area != test.area {
			t.Errorf("mapping %s = wordLen=%#x area=%#x ok=%t", test.address, wordLen, area, ok)
		}
	}
}
