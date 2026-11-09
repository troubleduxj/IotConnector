package main

import (
	"net/netip"
	"strings"
	"testing"
)

func TestParseCIDRsEmpty(t *testing.T) {
	for _, in := range []string{"", "   "} {
		got, err := parseCIDRs(in)
		if err != nil || got != nil {
			t.Errorf("parseCIDRs(%q) = %v, %v; want nil, nil", in, got, err)
		}
	}
}

func TestParseCIDRsValidList(t *testing.T) {
	got, err := parseCIDRs("10.1.2.3/8, 192.168.1.20")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	// 回环地址两条始终在前，之后是用户配置的两条。
	want := []string{"127.0.0.0/8", "::1/128", "10.0.0.0/8", "192.168.1.20/32"}
	if len(got) != len(want) {
		t.Fatalf("got %d prefixes %v, want %d", len(got), got, len(want))
	}
	for i, w := range want {
		if got[i].String() != w {
			t.Errorf("prefix[%d] = %s, want %s", i, got[i], w)
		}
	}
}

func TestParseCIDRsIPv6Single(t *testing.T) {
	got, err := parseCIDRs("fd00::5")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	last := got[len(got)-1]
	if last != netip.MustParsePrefix("fd00::5/128") {
		t.Errorf("last prefix = %s, want fd00::5/128", last)
	}
}

func TestParseCIDRsSeparatorsOnly(t *testing.T) {
	got, err := parseCIDRs(",")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(got) != 2 {
		t.Errorf("separators-only input should add no prefixes, got %v", got)
	}
}

func TestParseCIDRsInvalid(t *testing.T) {
	cases := map[string]string{
		"not-an-ip":      `invalid address "not-an-ip"`,
		"10.0.0.0/33":    `invalid CIDR "10.0.0.0/33"`,
		"10.0.0.1/8/x":   `invalid CIDR`,
		"10.0.0.0/8,bad": `invalid address "bad"`,
	}
	for in, wantSub := range cases {
		_, err := parseCIDRs(in)
		if err == nil {
			t.Errorf("parseCIDRs(%q): expected error", in)
			continue
		}
		if !strings.Contains(err.Error(), wantSub) {
			t.Errorf("parseCIDRs(%q) error = %q, want substring %q", in, err, wantSub)
		}
	}
}
