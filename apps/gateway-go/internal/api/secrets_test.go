package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/factorybridge/iotconnector/gateway-go/internal/acquisition"
	"github.com/factorybridge/iotconnector/gateway-go/internal/config"
)

func TestRedactSecretsHidesNestedValuesWithoutMutatingInput(t *testing.T) {
	input := map[string]any{
		"webhookUrl": "https://hook.example/?token=abc",
		"dingtalk":   map[string]any{"enabled": true, "webhookUrl": "https://oapi.dingtalk.com/x", "secret": "SEC123"},
		"email":      map[string]any{"host": "smtp.example", "password": "", "username": "u"},
		"list":       []any{map[string]any{"token": "t1"}},
	}
	out := redactSecrets(input).(map[string]any)
	ding := out["dingtalk"].(map[string]any)
	if ding["secret"] != "" || ding["secretSet"] != true || ding["webhookUrl"] != "" || ding["enabled"] != true {
		t.Fatalf("dingtalk not redacted: %#v", ding)
	}
	email := out["email"].(map[string]any)
	if email["passwordSet"] != false || email["host"] != "smtp.example" {
		t.Fatalf("email redaction wrong: %#v", email)
	}
	if out["list"].([]any)[0].(map[string]any)["token"] != "" {
		t.Fatal("secret inside array not redacted")
	}
	if input["dingtalk"].(map[string]any)["secret"] != "SEC123" {
		t.Fatal("redactSecrets mutated its input")
	}
}

func TestPreserveSecretsKeepsStoredValueOnBlankPatch(t *testing.T) {
	stored := map[string]any{"email": map[string]any{"password": "old", "host": "a"}}
	patch := map[string]any{"email": map[string]any{"password": "", "passwordSet": true, "host": "b"}}
	preserveSecrets(patch)
	mergeMap(stored, patch)
	email := stored["email"].(map[string]any)
	if email["password"] != "old" || email["host"] != "b" {
		t.Fatalf("merge result = %#v", email)
	}
	if _, leaked := email["passwordSet"]; leaked {
		t.Fatal("passwordSet marker was persisted")
	}

	patch = map[string]any{"email": map[string]any{"password": "new"}}
	preserveSecrets(patch)
	mergeMap(stored, patch)
	if stored["email"].(map[string]any)["password"] != "new" {
		t.Fatal("non-empty secret was not updated")
	}
}

func TestRedactURLCredentials(t *testing.T) {
	if got := redactURLCredentials("http://root:taosdata@127.0.0.1:6041"); got != "http://127.0.0.1:6041" {
		t.Fatalf("got %q", got)
	}
	if got := redactURLCredentials("http://127.0.0.1:6041"); got != "http://127.0.0.1:6041" {
		t.Fatalf("got %q", got)
	}
}

// 回归 B4：viewer 读配置接口时拿不到任何密钥原文。
func TestSecretEndpointsDoNotLeakToViewer(t *testing.T) {
	cfg := config.Config{Raw: map[string]any{
		"notifications": map[string]any{
			"webhookUrl": "https://hook.example/?token=LEAK-1",
			"dingtalk":   map[string]any{"enabled": true, "webhookUrl": "https://oapi.dingtalk.com/LEAK-2", "secret": "LEAK-3"},
			"email":      map[string]any{"password": "LEAK-4"},
		},
		"northbound": map[string]any{"url": "mqtt://broker:1883", "password": "LEAK-5"},
	}}
	server := NewServerWithOptions(cfg, acquisition.NewEngine(nil, nil, nil), SecurityOptions{ViewerToken: "viewer-token"})
	handler := server.Handler()
	for _, path := range []string{"/api/config", "/api/notifications", "/api/northbound", "/api/system/info"} {
		request := httptest.NewRequest(http.MethodGet, path, nil)
		request.Header.Set("Authorization", "Bearer viewer-token")
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		if response.Code != http.StatusOK {
			t.Fatalf("%s status=%d", path, response.Code)
		}
		if strings.Contains(response.Body.String(), "LEAK-") {
			t.Fatalf("%s leaks a secret: %s", path, response.Body.String())
		}
	}

	var notifications map[string]any
	request := httptest.NewRequest(http.MethodGet, "/api/notifications", nil)
	request.Header.Set("Authorization", "Bearer viewer-token")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	_ = json.Unmarshal(response.Body.Bytes(), &notifications)
	if notifications["dingtalk"].(map[string]any)["secretSet"] != true {
		t.Fatalf("secretSet marker missing: %s", response.Body.String())
	}
}

func TestSystemInfoRequiresAuthentication(t *testing.T) {
	server := NewServerWithOptions(config.Config{}, acquisition.NewEngine(nil, nil, nil), SecurityOptions{ViewerToken: "viewer-token"})
	response := httptest.NewRecorder()
	server.Handler().ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/system/info", nil))
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated system/info status=%d", response.Code)
	}
}
