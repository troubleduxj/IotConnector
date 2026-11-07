package api

import (
	"net/http"
	"testing"

	"github.com/factorybridge/iotconnector/gateway-go/internal/acquisition"
	"github.com/factorybridge/iotconnector/gateway-go/internal/config"
)

// B3：去掉"未配置认证即全放行"。没有任何凭据时，受保护接口一律 401。
func TestNoImplicitOpenMode(t *testing.T) {
	server := NewServerWithOptions(config.Config{}, acquisition.NewEngine(nil, nil, nil), SecurityOptions{})
	handler := server.Handler()
	for _, path := range []string{"/api/config", "/api/tags/live", "/api/users"} {
		if code := call(handler, "GET", path, "", "").Code; code != http.StatusUnauthorized {
			t.Errorf("%s with no credentials configured: %d", path, code)
		}
	}
	if code := call(handler, "POST", "/api/tags/t1/write", "", `{"value":1}`).Code; code != http.StatusUnauthorized {
		t.Errorf("write with no credentials configured: %d", code)
	}
}

func TestDevModeAllowsLocalhostOriginsOnly(t *testing.T) {
	dev := NewServerWithOptions(config.Config{}, acquisition.NewEngine(nil, nil, nil), SecurityOptions{AdminToken: "t", DevMode: true}).Handler()
	prod := NewServerWithOptions(config.Config{}, acquisition.NewEngine(nil, nil, nil), SecurityOptions{AdminToken: "t"}).Handler()
	post := func(h http.Handler, origin string) int {
		request := newJSONRequest("POST", "/api/tags/t1/write", `{"value":1}`)
		request.Header.Set("Authorization", "Bearer t")
		request.Header.Set("Origin", origin)
		return serve(h, request).Code
	}
	for _, origin := range []string{"http://localhost:5173", "http://127.0.0.1:3000"} {
		if code := post(dev, origin); code == http.StatusForbidden {
			t.Errorf("dev mode rejected %s", origin)
		}
		if code := post(prod, origin); code != http.StatusForbidden {
			t.Errorf("production accepted cross-site %s: %d", origin, code)
		}
	}
	for _, origin := range []string{"https://localhost:5173", "http://localhost.evil.example", "http://10.0.0.1:3000"} {
		if code := post(dev, origin); code != http.StatusForbidden {
			t.Errorf("dev mode accepted %s: %d", origin, code)
		}
	}
}

func TestDevNoAuthOnlyWhenRequested(t *testing.T) {
	devNoAuth := NewServerWithOptions(config.Config{}, acquisition.NewEngine(nil, nil, nil), SecurityOptions{DevNoAuth: true}).Handler()
	response := call(devNoAuth, "GET", "/api/auth/me", "", "")
	if response.Code != http.StatusOK {
		t.Fatalf("dev-no-auth /me: %d %s", response.Code, response.Body.String())
	}
	devOnly := NewServerWithOptions(config.Config{}, acquisition.NewEngine(nil, nil, nil), SecurityOptions{DevMode: true}).Handler()
	if code := call(devOnly, "GET", "/api/config", "", "").Code; code != http.StatusUnauthorized {
		t.Fatalf("--dev without --dev-no-auth skipped auth: %d", code)
	}
}
