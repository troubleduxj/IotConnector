package api

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"strconv"
	"strings"
)

// 统一错误体（F5）。
//
// 所有 /api 下的错误响应（状态码 ≥ 400）都是
//
//	{"ok": false, "error": "<可读消息>", "code": "<机器可读代码>", ...}
//
// error 保持原有文字，控制台和脚本照旧读取；code 按状态码给出，便于客户端分支判断。
// 处理函数里已有的额外字段（required、details 等）原样保留。
// 不在每个处理函数里改，而是在出口统一补齐：处理函数只写 JSON 时补 ok/code，
// 写的是纯文本（如 405、404）时改写成同样格式的 JSON。

// errorCodes 是状态码到 code 的映射；未列出的 4xx 为 "client_error"，5xx 为 "internal"。
var errorCodes = map[int]string{
	http.StatusBadRequest:            "bad_request",
	http.StatusUnauthorized:          "unauthorized",
	http.StatusForbidden:             "forbidden",
	http.StatusNotFound:              "not_found",
	http.StatusMethodNotAllowed:      "method_not_allowed",
	http.StatusConflict:              "conflict",
	http.StatusRequestEntityTooLarge: "payload_too_large",
	http.StatusUnprocessableEntity:   "unprocessable",
	http.StatusTooManyRequests:       "rate_limited",
	http.StatusBadGateway:            "bad_gateway",
	http.StatusServiceUnavailable:    "unavailable",
	http.StatusGatewayTimeout:        "timeout",
}

func errorCode(status int) string {
	if code, ok := errorCodes[status]; ok {
		return code
	}
	if status >= 500 {
		return "internal"
	}
	return "client_error"
}

// maxErrorBodyBytes 限制缓冲的错误体大小；超出则原样透传，不改写。
const maxErrorBodyBytes = 64 << 10

// withErrorEnvelope 为 /api/ 下的错误响应补齐统一格式。成功响应不缓冲、不改动。
func withErrorEnvelope(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasPrefix(r.URL.Path, "/api/") {
			next.ServeHTTP(w, r)
			return
		}
		ew := &errorWriter{ResponseWriter: w}
		next.ServeHTTP(ew, r)
		ew.finish()
	})
}

type errorWriter struct {
	http.ResponseWriter
	status   int
	buf      bytes.Buffer
	capture  bool // 正在缓冲错误体
	passthru bool // 已决定原样透传
}

func (e *errorWriter) WriteHeader(status int) {
	if e.status != 0 {
		return
	}
	e.status = status
	if status >= 400 {
		e.capture = true
		return
	}
	e.ResponseWriter.WriteHeader(status)
}

func (e *errorWriter) Write(p []byte) (int, error) {
	if e.status == 0 {
		e.WriteHeader(http.StatusOK)
	}
	if !e.capture {
		return e.ResponseWriter.Write(p)
	}
	if e.buf.Len()+len(p) > maxErrorBodyBytes {
		// 过大的错误体不改写，先把已缓冲的内容和状态码送出。
		e.capture, e.passthru = false, true
		e.ResponseWriter.WriteHeader(e.status)
		if _, err := e.ResponseWriter.Write(e.buf.Bytes()); err != nil {
			return 0, err
		}
		e.buf.Reset()
		return e.ResponseWriter.Write(p)
	}
	return e.buf.Write(p)
}

// Flush 让流式接口照常工作；错误体在 finish 时才写出。
func (e *errorWriter) Flush() {
	if e.capture {
		return
	}
	if f, ok := e.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

// Hijack 供 WebSocket 升级使用。
func (e *errorWriter) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	if h, ok := e.ResponseWriter.(http.Hijacker); ok {
		return h.Hijack()
	}
	return nil, nil, errors.New("hijack not supported")
}

func (e *errorWriter) Unwrap() http.ResponseWriter { return e.ResponseWriter }

func (e *errorWriter) finish() {
	if !e.capture {
		return
	}
	body := envelope(e.status, e.Header().Get("Content-Type"), e.buf.Bytes())
	h := e.Header()
	h.Set("Content-Type", "application/json; charset=utf-8")
	h.Set("Content-Length", strconv.Itoa(len(body)))
	h.Set("X-Content-Type-Options", "nosniff")
	e.ResponseWriter.WriteHeader(e.status)
	_, _ = e.ResponseWriter.Write(body)
}

// envelope 把原错误体改写成统一格式。
func envelope(status int, contentType string, raw []byte) []byte {
	out := map[string]any{}
	if strings.Contains(contentType, "json") {
		if err := json.Unmarshal(raw, &out); err != nil {
			out = map[string]any{}
		}
	}
	if _, ok := out["error"].(string); !ok {
		message := strings.TrimSpace(string(raw))
		if strings.Contains(contentType, "json") || message == "" {
			message = strings.ToLower(http.StatusText(status))
		}
		if existing, ok := out["error"]; ok && existing != nil {
			out["details"] = existing
		}
		out["error"] = message
	}
	out["ok"] = false
	if _, ok := out["code"].(string); !ok {
		out["code"] = errorCode(status)
	}
	body, err := json.Marshal(out)
	if err != nil {
		return []byte(`{"ok":false,"error":"internal error","code":"internal"}`)
	}
	return append(body, '\n')
}

// API 版本（F5）。当前版本为 v1：/api/v1/... 与 /api/... 指向同一组处理函数。
// 新客户端应使用 /api/v1；不带版本的 /api/... 保留兼容，日后出现 v2 时继续指向 v1。
const apiVersionPrefix = "/api/v1/"

// withAPIVersion 把 /api/v1/... 改写为 /api/...，在鉴权、白名单、CORS 之前执行，
// 因此两种路径的权限和校验完全一致。响应头 API-Version 标明实际使用的版本。
func withAPIVersion(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, apiVersionPrefix) || r.URL.Path == "/api/v1" {
			rest := strings.TrimPrefix(r.URL.Path, "/api/v1")
			r2 := r.Clone(r.Context())
			r2.URL.Path = "/api" + rest
			if r.URL.RawPath != "" {
				r2.URL.RawPath = "/api" + strings.TrimPrefix(r.URL.RawPath, "/api/v1")
			}
			r = r2
		}
		if strings.HasPrefix(r.URL.Path, "/api/") {
			w.Header().Set("API-Version", "1")
		}
		next.ServeHTTP(w, r)
	})
}
