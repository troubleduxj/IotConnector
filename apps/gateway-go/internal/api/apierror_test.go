package api

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/factorybridge/iotconnector/gateway-go/internal/acquisition"
	"github.com/factorybridge/iotconnector/gateway-go/internal/config"
)

func decodeError(t *testing.T, res *http.Response) map[string]any {
	t.Helper()
	if ct := res.Header.Get("Content-Type"); !strings.Contains(ct, "application/json") {
		t.Fatalf("error content-type = %q", ct)
	}
	var body map[string]any
	if err := json.NewDecoder(res.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if body["ok"] != false {
		t.Fatalf("ok = %v in %v", body["ok"], body)
	}
	if _, ok := body["error"].(string); !ok {
		t.Fatalf("error not a string in %v", body)
	}
	if _, ok := body["code"].(string); !ok {
		t.Fatalf("code missing in %v", body)
	}
	return body
}

func envelopeServer(t *testing.T) *httptest.Server {
	t.Helper()
	engine := acquisition.NewEngine(nil, nil, nil)
	server := NewServerWithOptions(config.Config{}, engine, SecurityOptions{ViewerToken: "viewer-token", AdminToken: "engineer-token"})
	httpServer := httptest.NewServer(server.Handler())
	t.Cleanup(httpServer.Close)
	return httpServer
}

func doRequest(t *testing.T, method, url, token, body string) *http.Response {
	t.Helper()
	req, err := http.NewRequest(method, url, strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { res.Body.Close() })
	return res
}

func TestErrorEnvelopeOnAuthAndRole(t *testing.T) {
	srv := envelopeServer(t)
	res := doRequest(t, "GET", srv.URL+"/api/channels", "", "")
	if res.StatusCode != http.StatusUnauthorized {
		t.Fatalf("status = %d", res.StatusCode)
	}
	if body := decodeError(t, res); body["code"] != "unauthorized" || body["error"] != "authentication required" {
		t.Fatalf("body = %v", body)
	}

	res = doRequest(t, "DELETE", srv.URL+"/api/channels/x", "viewer-token", "")
	if res.StatusCode != http.StatusForbidden {
		t.Fatalf("status = %d", res.StatusCode)
	}
	body := decodeError(t, res)
	if body["code"] != "forbidden" || body["required"] == nil {
		t.Fatalf("extra fields must be kept: %v", body)
	}
}

// 处理函数只写了 {"error": ...}、没写 ok 的，也要补齐。
func TestErrorEnvelopeAddsOkToHandlerErrors(t *testing.T) {
	srv := envelopeServer(t)
	res := doRequest(t, "PUT", srv.URL+"/api/channels/missing", "engineer-token", `{"name":"x"}`)
	if res.StatusCode != http.StatusNotFound {
		t.Fatalf("status = %d", res.StatusCode)
	}
	if body := decodeError(t, res); body["code"] != "not_found" || body["error"] != "channel not found" {
		t.Fatalf("body = %v", body)
	}
}

// ServeMux 自己写的纯文本 405/404 改写成 JSON。
func TestErrorEnvelopeRewritesPlainText(t *testing.T) {
	srv := envelopeServer(t)
	res := doRequest(t, "PATCH", srv.URL+"/api/channels", "engineer-token", "")
	if res.StatusCode != http.StatusMethodNotAllowed {
		t.Fatalf("status = %d", res.StatusCode)
	}
	if res.Header.Get("Allow") == "" {
		t.Fatal("Allow header lost")
	}
	if body := decodeError(t, res); body["code"] != "method_not_allowed" {
		t.Fatalf("body = %v", body)
	}

	res = doRequest(t, "GET", srv.URL+"/api/no-such-endpoint", "engineer-token", "")
	if res.StatusCode != http.StatusNotFound {
		t.Fatalf("status = %d", res.StatusCode)
	}
	if body := decodeError(t, res); body["code"] != "not_found" {
		t.Fatalf("body = %v", body)
	}
}

func TestSuccessResponsesUntouched(t *testing.T) {
	srv := envelopeServer(t)
	res := doRequest(t, "GET", srv.URL+"/api/health", "", "")
	if res.StatusCode != http.StatusOK {
		t.Fatalf("status = %d", res.StatusCode)
	}
	raw, _ := io.ReadAll(res.Body)
	if strings.Contains(string(raw), `"code"`) {
		t.Fatalf("success body modified: %s", raw)
	}
}

func TestAPIV1AliasSharesHandlersAndAuth(t *testing.T) {
	srv := envelopeServer(t)
	res := doRequest(t, "GET", srv.URL+"/api/v1/health", "", "")
	if res.StatusCode != http.StatusOK || res.Header.Get("API-Version") != "1" {
		t.Fatalf("v1 health: status %d, API-Version %q", res.StatusCode, res.Header.Get("API-Version"))
	}
	// 鉴权与不带版本的路径一致。
	res = doRequest(t, "GET", srv.URL+"/api/v1/channels", "", "")
	if res.StatusCode != http.StatusUnauthorized {
		t.Fatalf("v1 channels without token: %d", res.StatusCode)
	}
	decodeError(t, res)
	res = doRequest(t, "GET", srv.URL+"/api/v1/channels", "viewer-token", "")
	if res.StatusCode != http.StatusOK {
		t.Fatalf("v1 channels with token: %d", res.StatusCode)
	}
	res = doRequest(t, "DELETE", srv.URL+"/api/v1/channels/x", "viewer-token", "")
	if res.StatusCode != http.StatusForbidden {
		t.Fatalf("v1 role check: %d", res.StatusCode)
	}
}

func TestEnvelopeHelpers(t *testing.T) {
	cases := map[int]string{400: "bad_request", 418: "client_error", 500: "internal", 503: "unavailable"}
	for status, want := range cases {
		if got := errorCode(status); got != want {
			t.Fatalf("errorCode(%d) = %q, want %q", status, got, want)
		}
	}
	var body map[string]any
	if err := json.Unmarshal(envelope(400, "application/json", []byte(`{"error":["a","b"]}`)), &body); err != nil {
		t.Fatal(err)
	}
	if body["error"] != "bad request" || body["details"] == nil {
		t.Fatalf("non-string error must move to details: %v", body)
	}
	if err := json.Unmarshal(envelope(500, "text/plain", []byte("read error\n")), &body); err != nil {
		t.Fatal(err)
	}
	if body["error"] != "read error" || body["code"] != "internal" {
		t.Fatalf("plain text body = %v", body)
	}
}
