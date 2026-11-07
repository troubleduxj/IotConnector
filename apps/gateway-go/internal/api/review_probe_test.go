package api

// 主会话对子任务产出的核查用例：覆盖子任务测试没有覆盖的路径。

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/factorybridge/iotconnector/gateway-go/internal/acquisition"
	"github.com/factorybridge/iotconnector/gateway-go/internal/config"
	"github.com/factorybridge/iotconnector/gateway-go/internal/domain"
)

func probeServer(t *testing.T) (*Server, http.Handler) {
	t.Helper()
	cfg := config.Config{
		Channels: []domain.Channel{{ID: "c1", Name: "Line 1/PLC", Protocol: "Modbus TCP", Host: "10.0.0.1", Port: 502, Enabled: true,
			Params: map[string]any{"password": "chan-secret", "unitId": 1.0}}},
		Tags: []domain.Tag{{ID: "t1", ChannelID: "c1", Name: "T1", Address: "40001"}},
		Raw:  map[string]any{"northbound": map[string]any{"password": "nb-secret"}, "alarms": []any{}},
	}
	s := NewServerWithOptions(cfg, acquisition.NewEngine(nil, nil, nil), SecurityOptions{AdminToken: "t", ViewerToken: "v", OperatorToken: "o"})
	return s, s.Handler()
}

// 导出→改名→导入后，通道口令必须保留原值？不：导出时已脱敏，导入的通道不带口令（需用户重新填写）。
// 关键是导入不能把空口令或 "passwordSet" 标记写进配置。
func TestProbeImportDoesNotPersistRedactionMarkers(t *testing.T) {
	s, h := probeServer(t)
	exported := call(h, "GET", "/api/channels/c1/export", "t", "")
	var bundle map[string]any
	_ = json.Unmarshal(exported.Body.Bytes(), &bundle)
	bundle["channel"].(map[string]any)["name"] = "copy"
	body, _ := json.Marshal(bundle)
	if r := call(h, "POST", "/api/channels/import", "t", string(body)); r.Code != http.StatusCreated {
		t.Fatalf("import: %d %s", r.Code, r.Body.String())
	}
	for _, ch := range s.cfg().Channels {
		if ch.Name != "copy" {
			continue
		}
		if _, ok := ch.Params["passwordSet"]; ok {
			t.Fatalf("redaction marker persisted: %v", ch.Params)
		}
		if v, ok := ch.Params["password"]; ok && v != "" {
			t.Fatalf("unexpected password value: %v", v)
		}
		if ch.Params["unitId"] != 1.0 {
			t.Fatalf("non-secret param lost: %v", ch.Params)
		}
	}
}

// 文件名注入：通道名含引号与换行时，Content-Disposition 不得被截断或注入新头。
func TestProbeExportFilenameIsSafe(t *testing.T) {
	s, h := probeServer(t)
	s.configMu.Lock()
	_ = s.persistConfigLocked(func(c *config.Config) { c.Channels[0].Name = "a\"b\r\nX-Evil: 1" })
	s.configMu.Unlock()
	r := call(h, "GET", "/api/channels/c1/export", "t", "")
	cd := r.Header().Get("Content-Disposition")
	if strings.ContainsAny(cd[len(`attachment; filename="`):len(cd)-1], "\"\r\n") || r.Header().Get("X-Evil") != "" {
		t.Fatalf("unsafe header: %q", cd)
	}
}

// 权限：viewer 不能导出（含设备地址与点位表），operator 不能恢复配置。
func TestProbeRolesOnNewRoutes(t *testing.T) {
	_, h := probeServer(t)
	cases := []struct{ method, path, token string }{
		{"GET", "/api/channels/c1/export", "v"},
		{"POST", "/api/channels/import", "o"},
		{"GET", "/api/system/config-backup", "o"},
		{"POST", "/api/system/config-restore", "o"},
		{"POST", "/api/system/factory-reset", "o"},
		{"GET", "/api/system/diag", "o"},
		{"POST", "/api/scheduler/rebalance", "o"},
		{"GET", "/api/channels/c1/frames", "v"},
	}
	for _, c := range cases {
		if r := call(h, c.method, c.path, c.token, "{}"); r.Code != http.StatusForbidden {
			t.Errorf("%s %s as %s: %d", c.method, c.path, c.token, r.Code)
		}
	}
}

// 恢复后 ROC 告警的基线与风暴计数应重置，否则会拿恢复前的旧值比较。
func TestProbeRestoreResetsAlarmRuntimeState(t *testing.T) {
	s, h := probeServer(t)
	s.alarms.mu.Lock()
	s.alarms.last["old-rule"] = 99
	s.alarms.mu.Unlock()
	backup := call(h, "GET", "/api/system/config-backup", "t", "")
	if r := call(h, "POST", "/api/system/config-restore", "t", backup.Body.String()); r.Code != http.StatusOK {
		t.Fatalf("restore: %d %s", r.Code, r.Body.String())
	}
	s.alarms.mu.RLock()
	defer s.alarms.mu.RUnlock()
	if _, stale := s.alarms.last["old-rule"]; stale {
		t.Fatal("ROC baseline from before restore survived")
	}
}

// 恢复出厂不能清掉用户库（用户在 SQLite，不在配置里）。
func TestProbeFactoryResetKeepsUsers(t *testing.T) {
	users := newTestUsers(t, [3]string{"root", "root-password", "admin"})
	s := NewServerWithOptions(config.Config{}, acquisition.NewEngine(nil, nil, nil), SecurityOptions{Users: users})
	h := s.Handler()
	token := login(t, h, "root", "root-password")
	if r := call(h, "POST", "/api/system/factory-reset", token, `{"confirm":"RESET"}`); r.Code != http.StatusOK {
		t.Fatalf("reset: %d %s", r.Code, r.Body.String())
	}
	if r := call(h, "GET", "/api/auth/me", token, ""); r.Code != http.StatusOK {
		t.Fatalf("session lost after factory reset: %d", r.Code)
	}
}
