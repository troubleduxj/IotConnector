package api

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/factorybridge/iotconnector/gateway-go/internal/auth"
	"github.com/factorybridge/iotconnector/gateway-go/internal/db"
	"golang.org/x/crypto/bcrypt"
)

// newTestUsers 打开临时 SQLite 用户库，并按 "用户名:口令:角色" 建用户（bcrypt.MinCost 加速测试）。
// 口令以 "!" 开头表示首次登录必须改密。
func newTestUsers(t *testing.T, specs ...[3]string) *auth.UserStore {
	t.Helper()
	database, err := db.Open(context.Background(), t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { database.Close() })
	store := auth.NewUserStore(database, auth.UserStoreOptions{})
	for _, spec := range specs {
		password, mustChange := spec[1], false
		if len(password) > 0 && password[0] == '!' {
			password, mustChange = password[1:], true
		}
		hash, _ := bcrypt.GenerateFromPassword([]byte(password), bcrypt.MinCost)
		if _, err := store.ImportUser(context.Background(), spec[0], string(hash), auth.Role(spec[2]), mustChange); err != nil {
			t.Fatal(err)
		}
	}
	return store
}

func newJSONRequest(method, path, body string) *http.Request {
	request := httptest.NewRequest(method, path, strings.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	return request
}

func serve(handler http.Handler, request *http.Request) *httptest.ResponseRecorder {
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response
}
