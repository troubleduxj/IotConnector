package api

import (
	"errors"
	"io/fs"
	"net/http"
	"os"
	"path"
	"strings"
)

// 控制台静态文件托管（F1）。
//
// 前端构建产物（apps/console/dist）放到 web 目录后，网关同端口提供页面与 API，不再需要
// 单独起 Vite 或 npx serve。也可以不托管、把 web 目录放到 Nginx/IIS 下，并在
// GATEWAY_GO_CORS_ORIGINS 中加入该站点。

// webCSP 是页面的内容安全策略。
//   - script-src 'self'：构建产物没有内联脚本，禁止 eval 与第三方脚本。
//   - style-src 'unsafe-inline'：recharts 与 React 的 style 属性是内联样式，无法去掉；
//     内联样式不能执行代码，风险远小于内联脚本。
//   - connect-src 'self' ws: wss:：API 与 WebSocket 同源；ws/wss 需显式放行。
const webCSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; " +
	"font-src 'self' data:; connect-src 'self' ws: wss:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"

// Windows 注册表可能把 .js 映射为 text/plain，配合 nosniff 会导致脚本无法加载，所以显式指定。
var webTypes = map[string]string{
	".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png",
	".ico": "image/x-icon", ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf", ".txt": "text/plain; charset=utf-8",
	".webmanifest": "application/manifest+json", ".map": "application/json",
}

// newWebHandler 返回托管 dir 下静态文件的处理器；dir 为空、不存在或没有 index.html 时返回 nil（只提供 API）。
// 用 os.Root 打开目录：路径无法通过 ..、编码后的 %2e%2e、反斜杠或符号链接逃出 web 目录。
func newWebHandler(dir string) (http.Handler, func() error) {
	if dir == "" {
		return nil, nil
	}
	root, err := os.OpenRoot(dir)
	if err != nil {
		return nil, nil
	}
	if _, err := root.Stat("index.html"); err != nil {
		_ = root.Close()
		return nil, nil
	}
	fsys := root.FS()
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			w.Header().Set("Allow", "GET, HEAD")
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		h := w.Header()
		h.Set("Content-Security-Policy", webCSP)
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("X-Frame-Options", "DENY")
		h.Set("Referrer-Policy", "no-referrer")

		name := strings.TrimPrefix(path.Clean("/"+r.URL.Path), "/")
		if name == "" {
			name = "index.html"
		}
		// 隐藏文件（.git、.env 等）一律 404
		for _, part := range strings.Split(name, "/") {
			if strings.HasPrefix(part, ".") {
				http.NotFound(w, r)
				return
			}
		}
		info, err := fs.Stat(fsys, name)
		if err != nil || info.IsDir() {
			// 没有扩展名的路径按前端路由处理，回退到 index.html；带扩展名的缺失资源返回 404
			if path.Ext(name) != "" {
				http.NotFound(w, r)
				return
			}
			name = "index.html"
		}
		data, err := fs.ReadFile(fsys, name)
		if err != nil {
			if errors.Is(err, fs.ErrNotExist) {
				http.NotFound(w, r)
				return
			}
			http.Error(w, "read error", http.StatusInternalServerError)
			return
		}
		if contentType, ok := webTypes[path.Ext(name)]; ok {
			h.Set("Content-Type", contentType)
		}
		// Vite 产物文件名带内容哈希，可长期缓存；index.html 每次都要重新取，保证升级后立即生效
		if strings.HasPrefix(name, "assets/") {
			h.Set("Cache-Control", "public, max-age=31536000, immutable")
		} else {
			h.Set("Cache-Control", "no-cache")
		}
		if r.Method == http.MethodHead {
			return
		}
		_, _ = w.Write(data)
	}), root.Close
}

// withWeb 把非 /api、非 /ws、非 /metrics 的请求交给静态文件处理器。
func withWeb(api http.Handler, web http.Handler) http.Handler {
	if web == nil {
		return api
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p := r.URL.Path
		if strings.HasPrefix(p, "/api/") || p == "/api" || p == "/ws" || p == "/metrics" {
			api.ServeHTTP(w, r)
			return
		}
		web.ServeHTTP(w, r)
	})
}
