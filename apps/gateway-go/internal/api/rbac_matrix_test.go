package api

import (
	"net/http"
	"net/http/httptest"
	"sort"
	"strings"
	"testing"

	"github.com/factorybridge/iotconnector/gateway-go/internal/acquisition"
	"github.com/factorybridge/iotconnector/gateway-go/internal/config"
)

// expectedRoutePolicy 是每条路由应有的最低角色（E2）。
//
// 这张表是权限设计的"契约"：新增路由或改动角色时必须同步改这里，测试才会通过，
// 防止误把管理接口放宽、或把只读接口收紧到运维用不了。取值：
// public（无需登录）、signedIn（登录即可，含待改密账号）、viewer、operator、engineer、admin。
var expectedRoutePolicy = map[string]string{
	"GET /api/health":                      "public",
	"POST /api/auth/login":                 "public",
	"GET /ws":                              "public", // 握手内自行鉴权（ticket / Authorization）
	"GET /metrics":                         "viewer",
	"GET /api/metrics":                     "viewer",
	"GET /api/system/info":                 "viewer",
	"GET /api/channels":                    "viewer",
	"GET /api/tags":                        "viewer",
	"GET /api/tags/live":                   "viewer",
	"GET /api/config":                      "viewer",
	"POST /api/channels":                   "engineer",
	"PUT /api/channels/{channelID}":        "engineer",
	"GET /api/channels/{channelID}/driver": "operator",
	"PUT /api/channels/{channelID}/driver": "admin",
	"DELETE /api/channels/{channelID}":     "admin",
	"POST /api/channels/{channelID}/test":  "engineer",
	"GET /api/channels/{channelID}/export": "engineer",
	"POST /api/channels/import":            "engineer",
	"GET /api/channels/{channelID}/frames": "operator",
	"GET /api/northbound":                  "viewer",
	"PUT /api/northbound":                  "engineer",
	"POST /api/northbound/rebirth":         "engineer",
	"GET /api/users":                       "admin",
	"GET /api/audit":                       "admin",
	"POST /api/system/db-test":             "engineer",
	"POST /api/system/db-init":             "engineer",
	"GET /api/system/config-backup":        "admin",
	"POST /api/system/config-restore":      "admin",
	"POST /api/system/factory-reset":       "admin",
	"GET /api/system/openapi.json":         "operator",
}

func policyName(a access) string {
	switch {
	case a.public:
		return "public"
	case a.allowPending:
		return "signedIn"
	default:
		return string(a.role)
	}
}

// TestRoutePoliciesMatchContract 对照 expectedRoutePolicy 检查已列出路由的角色，
// 并列出所有路由及其角色，便于审阅（go test -v -run RoutePolicies）。
func TestRoutePoliciesMatchContract(t *testing.T) {
	NewServerWithOptions(config.Config{}, acquisition.NewEngine(nil, nil, nil), SecurityOptions{}).Handler()
	for pattern, want := range expectedRoutePolicy {
		a, ok := routePolicies[pattern]
		if !ok {
			t.Errorf("contract lists %q but no such route is registered", pattern)
			continue
		}
		if got := policyName(a); got != want {
			t.Errorf("%s: policy %s, contract says %s", pattern, got, want)
		}
	}
	patterns := make([]string, 0, len(routePolicies))
	for pattern := range routePolicies {
		patterns = append(patterns, pattern)
	}
	sort.Strings(patterns)
	for _, pattern := range patterns {
		t.Logf("%-10s %s", policyName(routePolicies[pattern]), pattern)
	}
}

// concretePath 把路由模式里的 {参数} 换成占位值，得到可请求的路径。
func concretePath(path string) string {
	var b strings.Builder
	for {
		start := strings.IndexByte(path, '{')
		if start < 0 {
			b.WriteString(path)
			return b.String()
		}
		end := strings.IndexByte(path[start:], '}')
		b.WriteString(path[:start])
		b.WriteString("x1")
		path = path[start+end+1:]
	}
}

// TestFullRBACMatrix 对每一条经 route() 注册的路由、每一种角色发请求（E2）：
// 角色不够时必须被拒（403 insufficient role），够时不能被拒。
// 同一条路由经 /api/v1 前缀访问时结果必须一致（F5）。
func TestFullRBACMatrix(t *testing.T) {
	tokens := map[Role]string{RoleViewer: "tok-viewer", RoleOperator: "tok-operator", RoleAdmin: "tok-admin"}
	server := NewServerWithOptions(config.Config{}, acquisition.NewEngine(nil, nil, nil), SecurityOptions{
		ViewerToken: tokens[RoleViewer], OperatorToken: tokens[RoleOperator], AdminToken: tokens[RoleAdmin],
		Users: newTestUsers(t, [3]string{"eng", "engineer-pass", "engineer"}),
	})
	handler := server.Handler()
	tokens[RoleEngineer] = login(t, handler, "eng", "engineer-pass")
	roles := []Role{RoleViewer, RoleOperator, RoleEngineer, RoleAdmin}

	patterns := make([]string, 0, len(routePolicies))
	for pattern := range routePolicies {
		patterns = append(patterns, pattern)
	}
	sort.Strings(patterns)

	checked := 0
	for _, pattern := range patterns {
		a := routePolicies[pattern]
		if a.public {
			continue
		}
		method, path, _ := strings.Cut(pattern, " ")
		// 会改动服务器状态、影响后续用例的接口：只测被拒的一侧（被拒时处理函数不会执行）。
		destructive := strings.Contains(path, "factory-reset") || strings.Contains(path, "config-restore") ||
			strings.HasSuffix(path, "/logout") || strings.Contains(path, "/sessions")
		for _, role := range roles {
			allowed := roleAtLeastForTest(role, a.role)
			if destructive && allowed {
				continue
			}
			for _, prefix := range []string{"", "/v1"} {
				target := concretePath(path)
				if prefix != "" {
					if !strings.HasPrefix(target, "/api/") {
						continue
					}
					target = "/api/v1" + strings.TrimPrefix(target, "/api")
				}
				request := httptest.NewRequest(method, target, strings.NewReader(`{}`))
				request.Header.Set("Content-Type", "application/json")
				request.Header.Set("Authorization", "Bearer "+tokens[role])
				response := httptest.NewRecorder()
				handler.ServeHTTP(response, request)
				blocked := response.Code == http.StatusForbidden && strings.Contains(response.Body.String(), "insufficient role")
				if blocked == allowed {
					t.Errorf("%s %s as %s: status=%d body=%.120s (want allowed=%v, policy=%s)",
						method, target, role, response.Code, response.Body.String(), allowed, policyName(a))
				}
				if response.Code == http.StatusUnauthorized {
					t.Errorf("%s %s as %s: token rejected (401)", method, target, role)
				}
				checked++
			}
		}
	}
	if checked < 300 {
		t.Fatalf("only %d route×role checks ran; expected the full matrix", checked)
	}
	t.Logf("%d route×role checks over %d routes", checked, len(patterns))
}
