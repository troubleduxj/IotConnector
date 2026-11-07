package api

import (
	"net/http"
	"testing"

	"github.com/factorybridge/iotconnector/gateway-go/internal/acquisition"
	"github.com/factorybridge/iotconnector/gateway-go/internal/config"
)

// C9：脚本连续失败被自动禁用后，手动重新启用必须清除标记与计数。
func TestReenableScriptClearsAutoDisable(t *testing.T) {
	cfg := config.Config{Raw: map[string]any{"scripts": []any{map[string]any{"id": "s1", "name": "x", "code": "log(1)", "enabled": false, "trigger": map[string]any{"type": "manual"}}}}}
	s := NewServerWithOptions(cfg, acquisition.NewEngine(nil, nil, nil), SecurityOptions{AdminToken: "t"})
	s.scriptEngine.mu.Lock()
	s.scriptEngine.stats["s1"] = scriptStat{AutoDisabled: true, ConsecutiveErrors: 3, Errors: 3}
	s.scriptEngine.mu.Unlock()

	if r := call(s.Handler(), "PUT", "/api/scripts/s1", "t", `{"enabled":true}`); r.Code != http.StatusOK {
		t.Fatalf("enable: %d %s", r.Code, r.Body.String())
	}
	stat := s.scriptEngine.getStat("s1")
	if stat.AutoDisabled || stat.ConsecutiveErrors != 0 {
		t.Fatalf("stat after re-enable = %+v", stat)
	}
	if stat.Errors != 3 {
		t.Fatalf("lifetime error count should be kept, got %d", stat.Errors)
	}
}
