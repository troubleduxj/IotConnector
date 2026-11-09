package main

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// resetSettings 让每个用例从干净的来源开始，并把弃用提示收集到 buffer。
func resetSettings(t *testing.T) *bytes.Buffer {
	t.Helper()
	var warn bytes.Buffer
	old := settings
	settings = &settingsSource{file: map[string]string{}, warned: map[string]bool{}, warn: &warn}
	t.Cleanup(func() { settings = old })
	for _, spec := range settingSpecs {
		t.Setenv(spec.env, "")
		if spec.legacy != "" {
			t.Setenv(spec.legacy, "")
		}
	}
	t.Setenv("FB_CONFIG", "")
	return &warn
}

func writeConfig(t *testing.T, body string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "factorybridge.yaml")
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestSettingPrecedence(t *testing.T) {
	warn := resetSettings(t)
	path := writeConfig(t, "port: 18100\nhost: 0.0.0.0\ntdengine:\n  url: http://file:6041\n  database: from_file\nallowCIDRs: [10.0.0.0/8, 192.168.1.20]\n")
	if err := settings.loadConfigFile(path); err != nil {
		t.Fatal(err)
	}
	// 只有文件
	if got := settingInt("port", 18080); got != 18100 {
		t.Fatalf("port from file = %d", got)
	}
	if got := setting("allowCIDRs", ""); got != "10.0.0.0/8,192.168.1.20" {
		t.Fatalf("list from file = %q", got)
	}
	if got := setting("tdengineDB", "factory_bridge"); got != "from_file" {
		t.Fatalf("nested key = %q", got)
	}
	// 旧环境变量盖过文件，并提示弃用一次
	t.Setenv("GATEWAY_GO_PORT", "18200")
	if got := settingInt("port", 18080); got != 18200 {
		t.Fatalf("legacy env over file = %d", got)
	}
	settingInt("port", 18080)
	if n := strings.Count(warn.String(), "GATEWAY_GO_PORT 已弃用"); n != 1 {
		t.Fatalf("deprecation warning count = %d: %s", n, warn.String())
	}
	// 新名盖过旧名
	t.Setenv("FB_PORT", "18300")
	if got := settingInt("port", 18080); got != 18300 {
		t.Fatalf("FB_ over legacy = %d", got)
	}
	// 未设置走默认值
	if got := setting("tdengineUser", "root"); got != "root" {
		t.Fatalf("default = %q", got)
	}
}

func TestConfigFileRejectsUnknownAndSecretKeys(t *testing.T) {
	resetSettings(t)
	for name, body := range map[string]string{
		"typo":     "prot: 1\n",
		"password": "tdengine:\n  password: secret\n",
		"token":    "adminToken: x\n",
		"dev":      "dev: true\n",
	} {
		err := settings.loadConfigFile(writeConfig(t, body))
		if err == nil || !strings.Contains(err.Error(), "未知键") {
			t.Fatalf("%s: err = %v", name, err)
		}
	}
	if err := settings.loadConfigFile(writeConfig(t, "- a\n- b\n")); err == nil {
		t.Fatal("non-mapping root should fail")
	}
}

func TestConfigFilePathFromArgsAndEnv(t *testing.T) {
	resetSettings(t)
	cases := map[string][]string{
		"/a.yaml": {"--config", "/a.yaml", "--port", "1"},
		"/b.yaml": {"--config=/b.yaml"},
		"/c.yaml": {"-config", "/c.yaml"},
	}
	for want, args := range cases {
		if got := configFilePath(args); got != want {
			t.Fatalf("configFilePath(%v) = %q", args, got)
		}
	}
	if got := configFilePath([]string{"--", "--config", "/x"}); got != "" {
		t.Fatalf("args after -- must be ignored, got %q", got)
	}
	t.Setenv("FB_CONFIG", "/env.yaml")
	if got := configFilePath(nil); got != "/env.yaml" {
		t.Fatalf("FB_CONFIG = %q", got)
	}
}

// run 用配置文件中的数据目录，且视为显式指定（不从旧 Node 目录复制）。
func TestRunUsesConfigFileForDataDir(t *testing.T) {
	resetSettings(t)
	dir := t.TempDir()
	path := writeConfig(t, "dataDir: "+filepath.ToSlash(dir)+"\nport: 70000\n")
	var stdout, stderr bytes.Buffer
	// 端口 70000 无效：run 在启动前就以参数错误退出，说明文件里的值已被读取。
	if code := dispatch([]string{"run", "--config", path}, &stdout, &stderr); code != exitUsage {
		t.Fatalf("exit = %d, stderr = %s", code, stderr.String())
	}
	if !strings.Contains(stderr.String(), "70000") {
		t.Fatalf("port from config file not applied: %s", stderr.String())
	}
	if !settingSet("dataDir") || setting("dataDir", "") != filepath.ToSlash(dir) {
		t.Fatal("dataDir from config file should count as explicit")
	}
}

func TestRunRejectsBadConfigFile(t *testing.T) {
	resetSettings(t)
	var stdout, stderr bytes.Buffer
	if code := dispatch([]string{"run", "--config", filepath.Join(t.TempDir(), "missing.yaml")}, &stdout, &stderr); code != exitConfig {
		t.Fatalf("missing file exit = %d", code)
	}
}

func TestTDenginePasswordAcceptsNewAndLegacyNames(t *testing.T) {
	resetSettings(t)
	t.Setenv("FB_TDENGINE_URL", "http://h:6041")
	if _, err := tdenginePassword(); err == nil {
		t.Fatal("URL without password must fail")
	}
	t.Setenv("TDENGINE_PASSWORD", "legacy")
	if got, err := tdenginePassword(); err != nil || got != "legacy" {
		t.Fatalf("legacy password = %q, %v", got, err)
	}
	t.Setenv("FB_TDENGINE_PASSWORD", "new")
	if got, _ := tdenginePassword(); got != "new" {
		t.Fatalf("FB_ password = %q", got)
	}
}
