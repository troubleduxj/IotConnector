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

func TestDevModeGuards(t *testing.T) {
	cases := []struct {
		args []string
		env  map[string]string
		out  string
	}{
		{[]string{"run", "--dev", "--host", "0.0.0.0"}, nil, "回环地址"},
		{[]string{"run", "--dev-no-auth", "--host", "192.168.1.5"}, nil, "回环地址"},
		{[]string{"run", "--dev"}, map[string]string{"INVOCATION_ID": "abc"}, "服务方式"},
		{[]string{"run", "--dev"}, map[string]string{"FB_SERVICE": "1"}, "服务方式"},
	}
	for _, tc := range cases {
		for k, v := range tc.env {
			t.Setenv(k, v)
		}
		var stdout, stderr bytes.Buffer
		if got := dispatch(tc.args, &stdout, &stderr); got != exitUsage || !strings.Contains(stderr.String(), tc.out) {
			t.Errorf("%v env=%v: exit=%d stderr=%q", tc.args, tc.env, got, stderr.String())
		}
		for k := range tc.env {
			t.Setenv(k, "")
		}
	}
	for _, host := range []string{"127.0.0.1", "localhost", "::1"} {
		if !isLoopback(host) {
			t.Errorf("%s should be loopback", host)
		}
	}
	for _, host := range []string{"0.0.0.0", "10.0.0.1", "example.com", ""} {
		if isLoopback(host) {
			t.Errorf("%s should not be loopback", host)
		}
	}
}

func TestServiceArgumentValidation(t *testing.T) {
	cases := []struct {
		args []string
		out  string
	}{
		{[]string{"service", "install"}, "绝对路径"},
		{[]string{"service", "install", "--data-dir", "relative/dir"}, "绝对路径"},
		{[]string{"service", "status", "--name", "bad name!"}, "服务名"},
		{[]string{"service", "install", "--data-dir", "/abs", "--", "--dev"}, "开发模式"},
		{[]string{"service", "install", "--data-dir", "/abs", "--", "--dev-no-auth"}, "开发模式"},
		{[]string{"service", "install", "--data-dir", "/abs", "--", "--data-dir", "/x"}, "--data-dir"},
		{[]string{"service", "install", "--data-dir", "/abs", "--", "--port", "abc"}, "run 参数无效"},
		{[]string{"service", "install", "--data-dir", "/abs", "--", "stray"}, "多余参数"},
		{[]string{"service", "frobnicate", "--name", "ok"}, ""},
	}
	for _, tc := range cases {
		var stdout, stderr bytes.Buffer
		code := dispatch(tc.args, &stdout, &stderr)
		if code != exitUsage && code != exitError {
			t.Errorf("%v: exit=%d", tc.args, code)
		}
		if tc.out != "" && !strings.Contains(stderr.String(), tc.out) {
			t.Errorf("%v: stderr=%q want %q", tc.args, stderr.String(), tc.out)
		}
	}
	got := serviceCommandLine(serviceOptions{dataDir: "/srv/fb", runArgs: []string{"--host", "0.0.0.0"}})
	if strings.Join(got, " ") != "run --data-dir /srv/fb --host 0.0.0.0" {
		t.Fatalf("command line %v", got)
	}
}
