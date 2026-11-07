package api

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/factorybridge/iotconnector/gateway-go/internal/acquisition"
	"github.com/factorybridge/iotconnector/gateway-go/internal/config"
)

func loginRequest(password, remoteAddr string) *http.Request {
	request := httptest.NewRequest(http.MethodPost, "/api/auth/login",
		strings.NewReader(`{"username":"admin","password":"`+password+`"}`))
	request.Header.Set("Content-Type", "application/json")
	request.RemoteAddr = remoteAddr
	return request
}

// 回归 B5：登录接口必须限速，否则口令可被无限次尝试。
func TestLoginIsRateLimitedPerClient(t *testing.T) {
	server := NewServerWithOptions(config.Config{}, acquisition.NewEngine(nil, nil, nil), SecurityOptions{
		LoginUsername: "admin",
		LoginPassword: "correct-password",
		FailureLimit:  3,
	})
	handler := server.Handler()

	for i := 0; i < 3; i++ {
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, loginRequest("wrong", "10.0.0.1:5000"))
		if response.Code != http.StatusUnauthorized {
			t.Fatalf("attempt %d status=%d", i+1, response.Code)
		}
	}
	// 达到上限后，即使口令正确也被拒绝
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, loginRequest("correct-password", "10.0.0.1:5000"))
	if response.Code != http.StatusTooManyRequests || response.Header().Get("Retry-After") == "" {
		t.Fatalf("locked client status=%d retry-after=%q", response.Code, response.Header().Get("Retry-After"))
	}
	// 其他来源不受影响：限速按 IP，不按用户名，攻击者无法借此锁死 admin
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, loginRequest("correct-password", "10.0.0.2:5000"))
	if response.Code != http.StatusOK {
		t.Fatalf("other client status=%d body=%s", response.Code, response.Body.String())
	}
}

func TestLoginSuccessClearsFailureCount(t *testing.T) {
	server := NewServerWithOptions(config.Config{}, acquisition.NewEngine(nil, nil, nil), SecurityOptions{
		LoginUsername: "admin",
		LoginPassword: "correct-password",
		FailureLimit:  3,
	})
	handler := server.Handler()
	for _, password := range []string{"wrong", "wrong", "correct-password", "wrong", "wrong"} {
		handler.ServeHTTP(httptest.NewRecorder(), loginRequest(password, "10.0.0.1:5000"))
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, loginRequest("correct-password", "10.0.0.1:5000"))
	if response.Code != http.StatusOK {
		t.Fatalf("failure count was not reset after success: status=%d", response.Code)
	}
}

func TestOversizedRequestBodyIsRejected(t *testing.T) {
	server := NewServerWithOptions(config.Config{}, acquisition.NewEngine(nil, nil, nil), SecurityOptions{
		LoginUsername: "admin",
		LoginPassword: "correct-password",
	})
	body := `{"username":"admin","password":"` + strings.Repeat("x", maxRequestBodyBytes) + `"}`
	request := httptest.NewRequest(http.MethodPost, "/api/auth/login", strings.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	server.Handler().ServeHTTP(response, request)
	if response.Code == http.StatusOK {
		t.Fatal("oversized body was accepted")
	}
}
