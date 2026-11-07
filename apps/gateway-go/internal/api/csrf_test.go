package api

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/factorybridge/iotconnector/gateway-go/internal/acquisition"
	"github.com/factorybridge/iotconnector/gateway-go/internal/config"
	"github.com/gorilla/websocket"
)

func newCSRFTestServer(t *testing.T) *httptest.Server {
	t.Helper()
	engine := acquisition.NewEngine(nil, nil, nil)
	server := NewServerWithOptions(config.Config{}, engine, SecurityOptions{
		OperatorToken: "operator-token",
		CORSOrigins:   []string{"http://console.example"},
	})
	httpServer := httptest.NewServer(server.Handler())
	t.Cleanup(httpServer.Close)
	return httpServer
}

// 回归 B2：跨站页面不能借浏览器发起写请求。
func TestCrossSiteWriteIsRejected(t *testing.T) {
	httpServer := newCSRFTestServer(t)
	cases := []struct {
		name        string
		origin      string
		contentType string
		want        int
	}{
		{"foreign origin json", "http://evil.example", "application/json", http.StatusForbidden},
		{"null origin", "null", "application/json", http.StatusForbidden},
		{"simple request text/plain", "", "text/plain", http.StatusUnsupportedMediaType},
		{"form post", "", "application/x-www-form-urlencoded", http.StatusUnsupportedMediaType},
		{"allowlisted origin", "http://console.example", "application/json", http.StatusOK},
		{"same origin", httpServer.URL, "application/json; charset=utf-8", http.StatusOK},
		{"non-browser client", "", "application/json", http.StatusOK},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			request, _ := http.NewRequest(http.MethodPost, httpServer.URL+"/api/tags/missing/write", strings.NewReader(`{"value":1}`))
			request.Header.Set("Authorization", "Bearer operator-token")
			request.Header.Set("Content-Type", tc.contentType)
			if tc.origin != "" {
				request.Header.Set("Origin", tc.origin)
			}
			response, err := http.DefaultClient.Do(request)
			if err != nil {
				t.Fatal(err)
			}
			response.Body.Close()
			if response.StatusCode != tc.want {
				t.Fatalf("status = %d, want %d", response.StatusCode, tc.want)
			}
		})
	}
}

func TestCrossSiteWebSocketIsRejected(t *testing.T) {
	httpServer := newCSRFTestServer(t)
	wsURL := "ws" + strings.TrimPrefix(httpServer.URL, "http") + "/ws"

	header := http.Header{"Authorization": {"Bearer operator-token"}, "Origin": {"http://evil.example"}}
	if conn, _, err := websocket.DefaultDialer.Dial(wsURL, header); err == nil {
		conn.Close()
		t.Fatal("cross-site websocket handshake unexpectedly succeeded")
	}

	header.Set("Origin", "http://console.example")
	conn, _, err := websocket.DefaultDialer.Dial(wsURL, header)
	if err != nil {
		t.Fatalf("allowlisted origin rejected: %v", err)
	}
	conn.Close()
}
