package main

import (
	"reflect"
	"testing"
	"time"

	"github.com/factorybridge/iotconnector/gateway-go/internal/config"
	"github.com/factorybridge/iotconnector/gateway-go/internal/domain"
)

func TestEnvOr(t *testing.T) {
	t.Setenv("FB_COV_TEST_STR", "")
	if got := envOr("FB_COV_TEST_STR", "fallback"); got != "fallback" {
		t.Errorf("empty env: got %q", got)
	}
	t.Setenv("FB_COV_TEST_STR", "custom")
	if got := envOr("FB_COV_TEST_STR", "fallback"); got != "custom" {
		t.Errorf("set env: got %q", got)
	}
}

func TestEnvInt(t *testing.T) {
	cases := []struct {
		name string
		val  string
		set  bool
		want int
	}{
		{"unset", "", false, 18080},
		{"empty", "", true, 18080},
		{"valid", "9000", true, 9000},
		{"upper bound", "65535", true, 65535},
		{"zero is out of range", "0", true, 18080},
		{"above range", "65536", true, 18080},
		{"not a number", "abc", true, 18080},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if tc.set {
				t.Setenv("FB_COV_TEST_INT", tc.val)
			}
			if got := envInt("FB_COV_TEST_INT", 18080); got != tc.want {
				t.Errorf("envInt(%q) = %d, want %d", tc.val, got, tc.want)
			}
		})
	}
}

func TestEnvBool(t *testing.T) {
	cases := map[string]bool{
		"1": true, "true": true, "YES": true, " on ": true,
		"0": false, "false": false, "No": false, "off": false,
		"maybe": false,
	}
	for val, want := range cases {
		t.Setenv("FB_COV_TEST_BOOL", val)
		if got := envBool("FB_COV_TEST_BOOL", false); got != want {
			t.Errorf("envBool(%q) = %v, want %v", val, got, want)
		}
	}
	t.Setenv("FB_COV_TEST_BOOL", "")
	if !envBool("FB_COV_TEST_BOOL", true) {
		t.Error("empty value should fall back to true")
	}
	if envBool("FB_COV_TEST_BOOL", false) {
		t.Error("empty value should fall back to false")
	}
	t.Setenv("FB_COV_TEST_BOOL", "maybe")
	if !envBool("FB_COV_TEST_BOOL", true) {
		t.Error("unrecognized value should fall back to true")
	}
}

func TestEnvDuration(t *testing.T) {
	cases := []struct {
		val  string
		want time.Duration
	}{
		{"", 7 * time.Second},
		{"5s", 5 * time.Second},
		{"250ms", 250 * time.Millisecond},
		{"bogus", 7 * time.Second},
		{"-1s", 7 * time.Second},
		{"0s", 7 * time.Second},
	}
	for _, tc := range cases {
		t.Setenv("FB_COV_TEST_DUR", tc.val)
		if got := envDuration("FB_COV_TEST_DUR", 7*time.Second); got != tc.want {
			t.Errorf("envDuration(%q) = %v, want %v", tc.val, got, tc.want)
		}
	}
}

func TestSplitCSV(t *testing.T) {
	if got := splitCSV(""); got != nil {
		t.Errorf("splitCSV(\"\") = %#v, want nil", got)
	}
	want := []string{"10.0.0.0/8", "192.168.1.20"}
	if got := splitCSV(" 10.0.0.0/8 , ,192.168.1.20,"); !reflect.DeepEqual(got, want) {
		t.Errorf("splitCSV = %#v, want %#v", got, want)
	}
}

func TestRawAccessors(t *testing.T) {
	root := map[string]any{
		"name":    "gw",
		"empty":   "",
		"enabled": true,
		"notBool": "true",
		"count":   float64(3),
		"zero":    float64(0),
		"neg":     float64(-2),
		"text":    "3",
	}
	if got := stringRaw(root, "name", "x"); got != "gw" {
		t.Errorf("stringRaw name = %q", got)
	}
	if got := stringRaw(root, "empty", "x"); got != "x" {
		t.Errorf("stringRaw empty should fall back, got %q", got)
	}
	if got := stringRaw(root, "text", "x"); got != "3" {
		t.Errorf("stringRaw text = %q", got)
	}
	if got := stringRaw("not a map", "name", "x"); got != "x" {
		t.Errorf("stringRaw on non-map = %q", got)
	}
	if !boolRaw(root, "enabled") {
		t.Error("boolRaw enabled should be true")
	}
	if boolRaw(root, "notBool") || boolRaw(root, "missing") || boolRaw(nil, "enabled") {
		t.Error("boolRaw should be false for non-bool, missing key, or non-map")
	}
	if got := intRaw(root, "count", 9); got != 3 {
		t.Errorf("intRaw count = %d, want 3", got)
	}
	if got := intRaw(root, "zero", 9); got != 9 {
		t.Errorf("intRaw zero should fall back, got %d", got)
	}
	if got := intRaw(root, "neg", 9); got != 9 {
		t.Errorf("intRaw negative should fall back, got %d", got)
	}
	if got := intRaw(root, "text", 9); got != 9 {
		t.Errorf("intRaw string should fall back, got %d", got)
	}
	if got := intRaw(42, "count", 9); got != 9 {
		t.Errorf("intRaw on non-map = %d, want 9", got)
	}
}

func TestToAcquisitionChannelsAndTags(t *testing.T) {
	cfg := config.Config{
		Channels: []domain.Channel{{ID: "c1", Protocol: "modbus-tcp", Host: "10.0.0.5", Port: 502, Enabled: true, PollIntervalMs: 1000}},
		Tags:     []domain.Tag{{ID: "t1", ChannelID: "c1", Name: "temp", Address: "40001", DataType: "float32"}},
	}
	channels := toAcquisitionChannels(cfg)
	if len(channels) != 1 {
		t.Fatalf("channels = %d, want 1", len(channels))
	}
	ch := channels[0]
	if ch.ID != "c1" || ch.Protocol != "modbus-tcp" || ch.Host != "10.0.0.5" || ch.Port != 502 || !ch.Enabled || ch.PollIntervalMs != 1000 {
		t.Errorf("channel mapped wrong: %+v", ch)
	}
	tags := toAcquisitionTags(cfg)
	if len(tags) != 1 {
		t.Fatalf("tags = %d, want 1", len(tags))
	}
	tg := tags[0]
	if tg.ID != "t1" || tg.ChannelID != "c1" || tg.Name != "temp" || tg.Address != "40001" || tg.DataType != "float32" {
		t.Errorf("tag mapped wrong: %+v", tg)
	}
	if got := toAcquisitionChannels(config.Config{}); got == nil || len(got) != 0 {
		t.Errorf("empty config should yield empty non-nil slice, got %#v", got)
	}
	if got := toAcquisitionTags(config.Config{}); got == nil || len(got) != 0 {
		t.Errorf("empty config should yield empty non-nil slice, got %#v", got)
	}
}
