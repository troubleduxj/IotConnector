package api

import (
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/factorybridge/iotconnector/gateway-go/internal/acquisition"
	"github.com/factorybridge/iotconnector/gateway-go/internal/config"
)

func newWebTestServer(t *testing.T) http.Handler {
	t.Helper()
	parent := t.TempDir()
	dir := filepath.Join(parent, "web")
	for name, content := range map[string]string{
		"index.html":           `<html><script type="module" src="/assets/app-abc.js"></script></html>`,
		"assets/app-abc.js":    `console.log(1)`,
		"assets/style-abc.css": `body{}`,
		".env":                 `SECRET=1`,
	} {
		full := filepath.Join(dir, filepath.FromSlash(name))
		_ = os.MkdirAll(filepath.Dir(full), 0o750)
		if err := os.WriteFile(full, []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	// 目录外的文件，用于验证路径穿越
	if err := os.WriteFile(filepath.Join(parent, "outside.txt"), []byte("outside"), 0o600); err != nil {
		t.Fatal(err)
	}
	server := NewServerWithOptions(config.Config{}, acquisition.NewEngine(nil, nil, nil), SecurityOptions{WebDir: dir, AdminToken: "t"})
	t.Cleanup(func() { _ = server.Close() }) // Windows 下目录句柄未关闭时 TempDir 无法删除
	return server.Handler()
}

func TestWebServesAssetsWithHeaders(t *testing.T) {
	h := newWebTestServer(t)
	response := call(h, "GET", "/", "", "")
	if response.Code != 200 || !strings.Contains(response.Body.String(), "app-abc.js") {
		t.Fatalf("index: %d %s", response.Code, response.Body.String())
	}
	if ct := response.Header().Get("Content-Type"); ct != "text/html; charset=utf-8" {
		t.Fatalf("index content-type %q", ct)
	}
	if response.Header().Get("Cache-Control") != "no-cache" || !strings.Contains(response.Header().Get("Content-Security-Policy"), "script-src 'self'") {
		t.Fatalf("index headers: %v", response.Header())
	}
	asset := call(h, "GET", "/assets/app-abc.js", "", "")
	if asset.Code != 200 || asset.Header().Get("Content-Type") != "text/javascript; charset=utf-8" || !strings.Contains(asset.Header().Get("Cache-Control"), "immutable") {
		t.Fatalf("asset: %d %v", asset.Code, asset.Header())
	}
}

func TestWebFallsBackToIndexForRoutesOnly(t *testing.T) {
	h := newWebTestServer(t)
	if r := call(h, "GET", "/devices/ch-1", "", ""); r.Code != 200 || !strings.Contains(r.Body.String(), "<html>") {
		t.Fatalf("route fallback: %d", r.Code)
	}
	if r := call(h, "GET", "/assets/missing.js", "", ""); r.Code != 404 {
		t.Fatalf("missing asset should 404, got %d", r.Code)
	}
}

func TestWebBlocksTraversalAndHiddenFiles(t *testing.T) {
	h := newWebTestServer(t)
	for _, p := range []string{"/../outside.txt", "/%2e%2e/outside.txt", "/assets/..%2f..%2foutside.txt", "/..\\outside.txt", "/.env", "/assets/../.env"} {
		r := call(h, "GET", p, "", "")
		if strings.Contains(r.Body.String(), "outside") || strings.Contains(r.Body.String(), "SECRET") {
			t.Errorf("%s leaked: %d %q", p, r.Code, r.Body.String())
		}
	}
}

func TestWebDoesNotShadowAPI(t *testing.T) {
	h := newWebTestServer(t)
	if r := call(h, "GET", "/api/health", "", ""); r.Code != 200 || !strings.Contains(r.Body.String(), `"ok":true`) {
		t.Fatalf("api health: %d %s", r.Code, r.Body.String())
	}
	if r := call(h, "GET", "/api/config", "", ""); r.Code != 401 {
		t.Fatalf("unknown or protected api path must not fall back to index.html: %d", r.Code)
	}
	if r := call(h, "POST", "/", "", "{}"); r.Code != 405 {
		t.Fatalf("POST to static path: %d", r.Code)
	}
}

func TestNoWebDirServesAPIOnly(t *testing.T) {
	h := NewServerWithOptions(config.Config{}, acquisition.NewEngine(nil, nil, nil), SecurityOptions{WebDir: filepath.Join(t.TempDir(), "missing")}).Handler()
	if r := call(h, "GET", "/", "", ""); r.Code != 404 {
		t.Fatalf("without web dir / should 404, got %d", r.Code)
	}
}
