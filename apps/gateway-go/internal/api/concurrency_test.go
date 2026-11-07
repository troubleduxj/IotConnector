package api

import (
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/factorybridge/iotconnector/gateway-go/internal/acquisition"
	"github.com/factorybridge/iotconnector/gateway-go/internal/config"
	"github.com/factorybridge/iotconnector/gateway-go/internal/domain"
)

// 回归 C2：采样回调、告警通知、脚本引擎读配置时，管理接口同时写配置。
// 原实现中采样与通知路径无锁读 config.Raw，会触发 Go 运行时的
// "concurrent map read and map write" 致命错误，整个进程退出（不是普通 panic，recover 也拦不住）。
func TestConcurrentConfigAccessDoesNotCrash(t *testing.T) {
	cfg := config.Config{
		Channels: []domain.Channel{{ID: "ch-1", Protocol: "simulation", Enabled: true}},
		Tags:     []domain.Tag{{ID: "tag-1", ChannelID: "ch-1", Name: "T1", DataType: "Float"}},
		Raw: map[string]any{
			"notifications": map[string]any{"enabled": false},
			"scripts":       []any{},
		},
	}
	engine := acquisition.NewEngine(nil, nil, nil)
	server := NewServerWithOptions(cfg, engine, SecurityOptions{AdminToken: "admin-token"})
	handler := server.Handler()

	value := 1.0
	sample := acquisition.Sample{TagID: "tag-1", Value: acquisition.Value{Number: &value}, Quality: acquisition.QualityGood, SampledAt: time.Now().UnixMilli()}

	deadline := time.Now().Add(1500 * time.Millisecond)
	var wg sync.WaitGroup
	// 读者：模拟采样回调路径（脚本触发检查、通知配置读取、位号查找）
	for i := 0; i < 4; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for time.Now().Before(deadline) {
				server.scriptEngine.onSample(sample)
				_ = server.notificationConfig()
				server.SetShadowDesiredByName("T1", 1, "test")
			}
		}()
	}
	// 写者：管理接口改通知配置和脚本
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for time.Now().Before(deadline) {
				request := httptest.NewRequest(http.MethodPut, "/api/notifications", strings.NewReader(`{"enabled":false,"webhookUrl":"https://x.example"}`))
				request.Header.Set("Authorization", "Bearer admin-token")
				request.Header.Set("Content-Type", "application/json")
				handler.ServeHTTP(httptest.NewRecorder(), request)

				request = httptest.NewRequest(http.MethodPost, "/api/scripts", strings.NewReader(`{"name":"s","code":"log(1)","enabled":false,"trigger":{"type":"manual"}}`))
				request.Header.Set("Authorization", "Bearer admin-token")
				request.Header.Set("Content-Type", "application/json")
				handler.ServeHTTP(httptest.NewRecorder(), request)
			}
		}()
	}
	wg.Wait()
}

// 写时复制顺带修正 C5 的一部分：保存失败时内存配置保持原样。
func TestFailedSaveLeavesConfigUnchanged(t *testing.T) {
	missing := t.TempDir() + "/file-not-dir"
	if err := os.WriteFile(missing, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	store := config.NewStore(missing) // 目录位置是一个普通文件，Save 必然失败
	cfg := config.Config{Raw: map[string]any{"notifications": map[string]any{"enabled": false}}}
	server := NewServerWithOptions(cfg, acquisition.NewEngine(nil, nil, nil), SecurityOptions{AdminToken: "admin-token", ConfigStore: &store})

	request := httptest.NewRequest(http.MethodPut, "/api/notifications", strings.NewReader(`{"enabled":true}`))
	request.Header.Set("Authorization", "Bearer admin-token")
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	server.Handler().ServeHTTP(response, request)
	if response.Code != http.StatusInternalServerError {
		t.Fatalf("expected save failure, status=%d body=%s", response.Code, response.Body.String())
	}
	if server.notificationConfig()["enabled"] != false {
		t.Fatal("in-memory config changed although save failed")
	}
}
