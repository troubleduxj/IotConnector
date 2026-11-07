package main

import (
	"bytes"
	"strings"
	"testing"
)

func TestDispatchExitCodes(t *testing.T) {
	cases := []struct {
		args []string
		want int
		out  string
	}{
		{[]string{"help"}, exitOK, "用法"},
		{[]string{"--help"}, exitOK, "用法"},
		{[]string{"version"}, exitOK, "factorybridge "},
		{[]string{"version", "--json"}, exitOK, `"version"`},
		{[]string{"version", "extra"}, exitUsage, "多余的参数"},
		{[]string{"nope"}, exitUsage, "未知命令"},
		{[]string{"run", "--port", "70000"}, exitUsage, "无效端口"},
		{[]string{"run", "--log-level", "loud"}, exitUsage, "无效日志级别"},
		{[]string{"run", "--no-such-flag"}, exitUsage, "no-such-flag"},
		{[]string{"run", "-h"}, exitOK, "-data-dir"},
	}
	for _, tc := range cases {
		var stdout, stderr bytes.Buffer
		got := dispatch(tc.args, &stdout, &stderr)
		if got != tc.want {
			t.Errorf("%v: exit=%d want %d (stderr=%s)", tc.args, got, tc.want, stderr.String())
		}
		if combined := stdout.String() + stderr.String(); !strings.Contains(combined, tc.out) {
			t.Errorf("%v: output %q missing %q", tc.args, combined, tc.out)
		}
	}
}
