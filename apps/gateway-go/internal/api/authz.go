package api

import (
	"context"
	"crypto/subtle"
	"net/http"
	"strings"

	"github.com/factorybridge/iotconnector/gateway-go/internal/auth"
)

// 统一鉴权（B7/H4）：每条路由注册时必须声明访问级别，默认拒绝。
// 处理函数内不再各自调用鉴权；身份通过 request context 传递。

type principalKey struct{}

// principal 返回当前请求的身份；公开路由上为零值。
func principal(r *http.Request) auth.Principal {
	p, _ := r.Context().Value(principalKey{}).(auth.Principal)
	return p
}

// actor 是写入审计和设备影子的操作者名称，只取自已认证的身份（B6：不再信任 X-User 头）。
func actor(r *http.Request) string {
	if name := principal(r).Username; name != "" {
		return name
	}
	return "anonymous"
}

type access struct {
	public       bool
	role         Role
	allowPending bool // 允许尚未完成强制改密的会话访问（me、logout、改密）
}

var (
	public        = access{public: true}
	signedIn      = access{role: RoleViewer, allowPending: true}
	viewerOnly    = access{role: RoleViewer}
	operatorOnly  = access{role: RoleOperator}
	engineerOnly  = access{role: RoleEngineer}
	adminOnly     = access{role: RoleAdmin}
	routePolicies = map[string]access{} // pattern -> access，供测试检查覆盖面
)

// route 注册一条路由并套上鉴权。pattern 形如 "GET /api/tags"。
func (s *Server) route(mux *http.ServeMux, pattern string, a access, h http.HandlerFunc) {
	routePolicies[pattern] = a
	if a.public {
		mux.HandleFunc(pattern, h)
		return
	}
	mux.Handle(pattern, s.require(a, h))
}

func (s *Server) require(a access, next http.HandlerFunc) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p, status, message := s.authenticateRequest(r)
		if status != 0 {
			if status == http.StatusUnauthorized {
				w.Header().Set("WWW-Authenticate", `Bearer realm="factorybridge"`)
			}
			if status == http.StatusTooManyRequests {
				w.Header().Set("Retry-After", "60")
			}
			writeJSON(w, status, map[string]any{"ok": false, "error": message})
			return
		}
		if !auth.RoleAtLeast(p.Role, a.role) {
			writeJSON(w, http.StatusForbidden, map[string]any{"ok": false, "error": "insufficient role", "required": a.role})
			return
		}
		if p.MustChangePassword && !a.allowPending {
			writeJSON(w, http.StatusForbidden, map[string]any{"ok": false, "error": "password change required"})
			return
		}
		next(w, r.WithContext(context.WithValue(r.Context(), principalKey{}, p)))
	})
}

// authenticateRequest 校验 Authorization 头。返回非零 status 表示拒绝。
func (s *Server) authenticateRequest(r *http.Request) (auth.Principal, int, string) {
	if s.devNoAuth {
		return devPrincipal, 0, ""
	}
	if s.rateLimited(r) {
		return auth.Principal{}, http.StatusTooManyRequests, "too many authentication failures"
	}
	token := bearerToken(r)
	if p, ok := s.authenticateToken(r.Context(), token); ok {
		s.clearAuthFailure(r)
		return p, 0, ""
	}
	if token != "" {
		s.recordAuthFailure(r)
	}
	return auth.Principal{}, http.StatusUnauthorized, "authentication required"
}

// devPrincipal 是 --dev-no-auth 下所有请求的身份。审计中可据此区分开发期操作。
var devPrincipal = auth.Principal{UserID: "dev", Username: "dev(no-auth)", Role: RoleAdmin}

// authenticateToken 依次尝试用户会话与静态 API 令牌。
func (s *Server) authenticateToken(ctx context.Context, token string) (auth.Principal, bool) {
	if token == "" {
		return auth.Principal{}, false
	}
	if s.users != nil {
		if p, ok := s.users.Authenticate(ctx, token); ok {
			return p, true
		}
	}
	for credential, role := range s.credentials {
		if subtle.ConstantTimeCompare([]byte(token), []byte(credential)) == 1 {
			return auth.Principal{Username: "token:" + string(role), Role: role}, true
		}
	}
	return auth.Principal{}, false
}

func bearerToken(r *http.Request) string {
	const prefix = "Bearer "
	header := r.Header.Get("Authorization")
	if len(header) > len(prefix) && strings.EqualFold(header[:len(prefix)], prefix) {
		return strings.TrimSpace(header[len(prefix):])
	}
	return ""
}
