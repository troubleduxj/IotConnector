package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/factorybridge/iotconnector/gateway-go/internal/acquisition"
	"github.com/factorybridge/iotconnector/gateway-go/internal/config"
)

// 每条路由都必须经 route() 注册并声明访问级别（B7 默认拒绝）。
// 绕过 route() 直接调用 mux.Handle/HandleFunc 的路由不会出现在 routePolicies 中，
// 运行期无法枚举 ServeMux，所以这里扫描本包源码：除 route() 自身外不允许出现这两个调用。
func TestNoRouteBypassesPolicy(t *testing.T) {
	files, err := filepath.Glob("*.go")
	if err != nil {
		t.Fatal(err)
	}
	for _, file := range files {
		if strings.HasSuffix(file, "_test.go") {
			continue
		}
		data, err := os.ReadFile(file)
		if err != nil {
			t.Fatal(err)
		}
		for i, line := range strings.Split(string(data), "\n") {
			trimmed := strings.TrimSpace(line)
			if !strings.HasPrefix(trimmed, "mux.Handle") {
				continue
			}
			// route() 内部的两处注册是唯一允许的调用
			if file == "authz.go" && (trimmed == "mux.HandleFunc(pattern, h)" || trimmed == "mux.Handle(pattern, s.require(a, h))") {
				continue
			}
			t.Errorf("%s:%d registers a route without a policy: %s", file, i+1, trimmed)
		}
	}
}

func TestEveryRouteHasDeclaredPolicy(t *testing.T) {
	server := NewServerWithOptions(config.Config{}, acquisition.NewEngine(nil, nil, nil), SecurityOptions{})
	_ = server.Handler()
	if len(routePolicies) < 60 {
		t.Fatalf("only %d routes registered through route(); expected the full API", len(routePolicies))
	}
	publicRoutes := []string{}
	for pattern, a := range routePolicies {
		if a.public {
			publicRoutes = append(publicRoutes, pattern)
		}
	}
	// 公开路由必须是这个固定集合：任何新增的公开路由都要在这里显式登记并说明理由。
	allowed := map[string]bool{
		"GET /api/health":      true, // 探活，只返回计数
		"POST /api/auth/login": true,
		"GET /ws":              true, // 握手内自行鉴权（浏览器不能给 WebSocket 设 Authorization 头）
	}
	for _, pattern := range publicRoutes {
		if !allowed[pattern] {
			t.Errorf("route %s is public but not in the allowlist", pattern)
		}
	}
}

func TestUnauthenticatedRequestsAreRejectedEverywhere(t *testing.T) {
	server := NewServerWithOptions(config.Config{}, acquisition.NewEngine(nil, nil, nil), SecurityOptions{})
	handler := server.Handler()
	for pattern, a := range routePolicies {
		if a.public {
			continue
		}
		method, path, _ := strings.Cut(pattern, " ")
		path = strings.NewReplacer("{channelID}", "c1", "{tagID}", "t1", "{alarmID}", "a1", "{eventID}", "e1",
			"{taskID}", "k1", "{recipeID}", "r1", "{scriptID}", "s1", "{userID}", "u1", "{sessionID}", "abcdef012345").Replace(path)
		request := httptest.NewRequest(method, path, strings.NewReader(`{}`))
		request.Header.Set("Content-Type", "application/json")
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		if response.Code != http.StatusUnauthorized && response.Code != http.StatusTooManyRequests {
			t.Errorf("%s without credentials: status=%d", pattern, response.Code)
		}
	}
}

// 表驱动 RBAC 矩阵：每个角色对代表性路由的期望结果。只断言"是否被鉴权层拦下"（403），
// 放行后的业务结果（404/400/200）不在此测试范围。
func TestRBACMatrix(t *testing.T) {
	tokens := map[Role]string{RoleViewer: "tok-viewer", RoleOperator: "tok-operator", RoleAdmin: "tok-admin"}
	server := NewServerWithOptions(config.Config{}, acquisition.NewEngine(nil, nil, nil), SecurityOptions{
		ViewerToken: tokens[RoleViewer], OperatorToken: tokens[RoleOperator], AdminToken: tokens[RoleAdmin],
		Users: newTestUsers(t, [3]string{"eng", "engineer-pass", "engineer"}),
	})
	handler := server.Handler()
	engineerToken := login(t, handler, "eng", "engineer-pass")

	cases := []struct {
		method, path string
		minRole      Role
	}{
		{"GET", "/api/tags/live", RoleViewer},
		{"GET", "/api/config", RoleViewer},
		{"POST", "/api/tags/t1/write", RoleOperator},
		{"POST", "/api/alarms/events/e1/ack", RoleOperator},
		{"POST", "/api/scripts/s1/run", RoleOperator},
		{"POST", "/api/channels", RoleEngineer},
		{"PUT", "/api/notifications", RoleEngineer},
		{"POST", "/api/scripts", RoleEngineer},
		{"DELETE", "/api/channels/c1", RoleAdmin},
		{"PUT", "/api/channels/c1/driver", RoleAdmin},
		{"GET", "/api/users", RoleAdmin},
		{"GET", "/api/audit", RoleAdmin},
	}
	callers := []struct {
		role  Role
		token string
	}{{RoleViewer, tokens[RoleViewer]}, {RoleOperator, tokens[RoleOperator]}, {RoleEngineer, engineerToken}, {RoleAdmin, tokens[RoleAdmin]}}
	for _, tc := range cases {
		for _, caller := range callers {
			request := httptest.NewRequest(tc.method, tc.path, strings.NewReader(`{}`))
			request.Header.Set("Content-Type", "application/json")
			request.Header.Set("Authorization", "Bearer "+caller.token)
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, request)
			blocked := response.Code == http.StatusForbidden && strings.Contains(response.Body.String(), "insufficient role")
			wantBlocked := !roleAtLeastForTest(caller.role, tc.minRole)
			if blocked != wantBlocked {
				t.Errorf("%s %s as %s: status=%d body=%s (want blocked=%v)", tc.method, tc.path, caller.role, response.Code, response.Body.String(), wantBlocked)
			}
		}
	}
}

func roleAtLeastForTest(actual, required Role) bool {
	rank := map[Role]int{RoleViewer: 1, RoleOperator: 2, RoleEngineer: 3, RoleAdmin: 4}
	return rank[actual] >= rank[required]
}

func login(t *testing.T, handler http.Handler, username, password string) string {
	t.Helper()
	request := httptest.NewRequest(http.MethodPost, "/api/auth/login", strings.NewReader(`{"username":"`+username+`","password":"`+password+`"}`))
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	var body struct {
		Token string `json:"token"`
	}
	if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &body) != nil || body.Token == "" {
		t.Fatalf("login %s: status=%d body=%s", username, response.Code, response.Body.String())
	}
	return body.Token
}

func call(handler http.Handler, method, path, token, body string) *httptest.ResponseRecorder {
	request := httptest.NewRequest(method, path, strings.NewReader(body))
	if body != "" {
		request.Header.Set("Content-Type", "application/json")
	}
	if token != "" {
		request.Header.Set("Authorization", "Bearer "+token)
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response
}

// 用户管理全链路：创建→新用户强制改密→改密后可用→降级立即失效→删除。
func TestUsersAPILifecycle(t *testing.T) {
	server := NewServerWithOptions(config.Config{}, acquisition.NewEngine(nil, nil, nil), SecurityOptions{
		Users: newTestUsers(t, [3]string{"root", "root-password", "admin"}),
	})
	handler := server.Handler()
	admin := login(t, handler, "root", "root-password")

	response := call(handler, "POST", "/api/users", admin, `{"username":"op1","password":"weak","role":"operator"}`)
	if response.Code != http.StatusBadRequest {
		t.Fatalf("weak password accepted: %d %s", response.Code, response.Body.String())
	}
	response = call(handler, "POST", "/api/users", admin, `{"username":"op1","password":"Initial-Passw0rd!","role":"superuser"}`)
	if response.Code != http.StatusBadRequest {
		t.Fatalf("invalid role accepted: %d", response.Code)
	}
	response = call(handler, "POST", "/api/users", admin, `{"username":"op1","password":"Initial-Passw0rd!","role":"operator"}`)
	if response.Code != http.StatusCreated || strings.Contains(response.Body.String(), "Initial-Passw0rd") || strings.Contains(response.Body.String(), "hash") {
		t.Fatalf("create: %d %s", response.Code, response.Body.String())
	}
	var created struct {
		ID string `json:"id"`
	}
	_ = json.Unmarshal(response.Body.Bytes(), &created)
	if call(handler, "POST", "/api/users", admin, `{"username":"OP1","password":"Initial-Passw0rd!","role":"viewer"}`).Code != http.StatusConflict {
		t.Fatal("duplicate username (case-insensitive) accepted")
	}

	op := login(t, handler, "op1", "Initial-Passw0rd!")
	if response := call(handler, "GET", "/api/tags/live", op, ""); response.Code != http.StatusForbidden || !strings.Contains(response.Body.String(), "password change required") {
		t.Fatalf("new user not forced to change password: %d %s", response.Code, response.Body.String())
	}
	if call(handler, "GET", "/api/auth/me", op, "").Code != http.StatusOK {
		t.Fatal("pending user could not read /me")
	}
	if response := call(handler, "POST", "/api/auth/password", op, `{"currentPassword":"Initial-Passw0rd!","newPassword":"Changed-Passw0rd!"}`); response.Code != http.StatusOK {
		t.Fatalf("change password: %d %s", response.Code, response.Body.String())
	}
	if call(handler, "GET", "/api/tags/live", op, "").Code != http.StatusOK {
		t.Fatal("user still blocked after changing password")
	}

	if response := call(handler, "PUT", "/api/users/"+created.ID, admin, `{"role":"viewer"}`); response.Code != http.StatusOK {
		t.Fatalf("demote: %d %s", response.Code, response.Body.String())
	}
	if call(handler, "GET", "/api/tags/live", op, "").Code != http.StatusUnauthorized {
		t.Fatal("session survived role change")
	}
	op = login(t, handler, "op1", "Changed-Passw0rd!")
	if call(handler, "POST", "/api/tags/t1/write", op, `{"value":1}`).Code != http.StatusForbidden {
		t.Fatal("demoted user can still write")
	}

	sessions := call(handler, "GET", "/api/auth/sessions", admin, "")
	if sessions.Code != http.StatusOK || !strings.Contains(sessions.Body.String(), `"current":true`) || strings.Contains(sessions.Body.String(), op) {
		t.Fatalf("sessions: %d %s", sessions.Code, sessions.Body.String())
	}

	if response := call(handler, "DELETE", "/api/users/"+created.ID, admin, ""); response.Code != http.StatusOK {
		t.Fatalf("delete: %d", response.Code)
	}
	if call(handler, "GET", "/api/tags/live", op, "").Code != http.StatusUnauthorized {
		t.Fatal("session survived delete")
	}

	audit := call(handler, "GET", "/api/audit", admin, "")
	if audit.Code != http.StatusOK {
		t.Fatalf("audit: %d", audit.Code)
	}
}

func TestAdminCannotLockThemselvesOut(t *testing.T) {
	users := newTestUsers(t, [3]string{"root", "root-password", "admin"})
	server := NewServerWithOptions(config.Config{}, acquisition.NewEngine(nil, nil, nil), SecurityOptions{Users: users})
	handler := server.Handler()
	admin := login(t, handler, "root", "root-password")
	me := call(handler, "GET", "/api/auth/me", admin, "")
	var body struct {
		ID string `json:"id"`
	}
	_ = json.Unmarshal(me.Body.Bytes(), &body)
	for _, patch := range []string{`{"role":"viewer"}`, `{"disabled":true}`} {
		if response := call(handler, "PUT", "/api/users/"+body.ID, admin, patch); response.Code != http.StatusConflict {
			t.Fatalf("self %s: %d", patch, response.Code)
		}
	}
	if call(handler, "DELETE", "/api/users/"+body.ID, admin, "").Code != http.StatusConflict {
		t.Fatal("admin deleted themselves")
	}
}

// 静态令牌不能管理用户，防止令牌泄露后被用来创建持久账号。
func TestStaticTokenCannotManageUsers(t *testing.T) {
	server := NewServerWithOptions(config.Config{}, acquisition.NewEngine(nil, nil, nil), SecurityOptions{
		AdminToken: "static-admin",
		Users:      newTestUsers(t, [3]string{"root", "root-password", "admin"}),
	})
	response := call(server.Handler(), "POST", "/api/users", "static-admin", `{"username":"x","password":"Initial-Passw0rd!","role":"admin"}`)
	if response.Code != http.StatusForbidden {
		t.Fatalf("static token created a user: %d %s", response.Code, response.Body.String())
	}
}
