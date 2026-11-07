package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/factorybridge/iotconnector/gateway-go/internal/acquisition"
	"github.com/factorybridge/iotconnector/gateway-go/internal/audit"
	"github.com/factorybridge/iotconnector/gateway-go/internal/config"
	"github.com/factorybridge/iotconnector/gateway-go/internal/domain"
	"golang.org/x/crypto/bcrypt"
)

type writeDriver struct {
	last acquisition.Value
}

func (d *writeDriver) Start(context.Context) error { return nil }
func (d *writeDriver) Stop(context.Context) error  { return nil }
func (d *writeDriver) Read(context.Context, []acquisition.Tag) ([]acquisition.Sample, error) {
	return nil, nil
}
func (d *writeDriver) Write(_ context.Context, _ acquisition.Tag, value acquisition.Value) error {
	d.last = value
	return nil
}
func (d *writeDriver) Test(context.Context, []acquisition.Tag) error { return nil }

func TestWriteTagAcceptsJSONScalar(t *testing.T) {
	driver := &writeDriver{}
	engine := acquisition.NewEngine(
		[]acquisition.Channel{{ID: "ch-1", Enabled: true}},
		[]acquisition.Tag{{ID: "tag-1", ChannelID: "ch-1"}},
		func(_ acquisition.Channel, _ []acquisition.Tag, _ func(acquisition.Sample), _ func(acquisition.ChannelStatus)) acquisition.Driver {
			return driver
		},
	)
	if err := engine.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	defer engine.Stop(context.Background())

	server := NewServer(config.Config{}, engine)
	tests := []struct {
		name  string
		body  string
		check func(t *testing.T, value acquisition.Value)
	}{
		{name: "number", body: `{"value":12.5}`, check: func(t *testing.T, value acquisition.Value) {
			if value.Number == nil || *value.Number != 12.5 {
				t.Fatalf("unexpected number: %#v", value)
			}
		}},
		{name: "boolean", body: `{"value":true}`, check: func(t *testing.T, value acquisition.Value) {
			if value.Bool == nil || !*value.Bool {
				t.Fatalf("unexpected bool: %#v", value)
			}
		}},
		{name: "string", body: `{"value":"RUN"}`, check: func(t *testing.T, value acquisition.Value) {
			if value.String == nil || *value.String != "RUN" {
				t.Fatalf("unexpected string: %#v", value)
			}
		}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodPost, "/api/tags/tag-1/write", strings.NewReader(test.body))
			req.Header.Set("Content-Type", "application/json")
			recorder := httptest.NewRecorder()
			server.Handler().ServeHTTP(recorder, req)
			if recorder.Code != http.StatusOK {
				t.Fatalf("status=%d body=%s", recorder.Code, recorder.Body.String())
			}
			var response map[string]any
			if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
				t.Fatal(err)
			}
			if response["ok"] != true {
				t.Fatalf("unexpected response: %#v", response)
			}
			test.check(t, driver.last)
		})
	}
}

func TestPrometheusMetricsEndpoint(t *testing.T) {
	server := NewServer(config.Config{}, acquisition.NewEngine(nil, nil, nil))
	request := httptest.NewRequest(http.MethodGet, "/metrics", nil)
	recorder := httptest.NewRecorder()
	server.Handler().ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	if got := recorder.Header().Get("Content-Type"); !strings.HasPrefix(got, "text/plain; version=0.0.4") {
		t.Fatalf("content type=%q", got)
	}
	body := recorder.Body.String()
	for _, metric := range []string{
		"factorybridge_acquisition_samples_total",
		"factorybridge_acquisition_channels{state=\"offline\"}",
		"factorybridge_acquisition_recoveries_total",
		"factorybridge_acquisition_reconnects_total",
		"factorybridge_storage_dropped_total",
	} {
		if !strings.Contains(body, metric) {
			t.Fatalf("missing metric %q in %s", metric, body)
		}
	}
}

func TestChannelDriverEndpointPersistsGraySwitch(t *testing.T) {
	server := NewServer(config.Config{Channels: []domain.Channel{{ID: "bac-1", Protocol: "BACnet/IP", Params: map[string]any{}}}}, acquisition.NewEngine(nil, nil, nil))
	request := httptest.NewRequest(http.MethodGet, "/api/channels/bac-1/driver", nil)
	recorder := httptest.NewRecorder()
	server.Handler().ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK || !strings.Contains(recorder.Body.String(), `"driver":"auto"`) {
		t.Fatalf("unexpected initial driver response: status=%d body=%s", recorder.Code, recorder.Body.String())
	}

	request = httptest.NewRequest(http.MethodPut, "/api/channels/bac-1/driver", strings.NewReader(`{"driver":"go"}`))
	request.Header.Set("Content-Type", "application/json")
	recorder = httptest.NewRecorder()
	server.Handler().ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK || !strings.Contains(recorder.Body.String(), `"driver":"go"`) {
		t.Fatalf("unexpected Go switch response: status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	if got := server.cfg().Channels[0].Params["driver"]; got != "bacnet-go" {
		t.Fatalf("stored driver=%v, want bacnet-go", got)
	}

	request = httptest.NewRequest(http.MethodPut, "/api/channels/bac-1/driver", strings.NewReader(`{"driver":"node"}`))
	request.Header.Set("Content-Type", "application/json")
	recorder = httptest.NewRecorder()
	server.Handler().ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK || server.cfg().Channels[0].Params["driver"] != "node" {
		t.Fatalf("unexpected Node rollback response: status=%d body=%s", recorder.Code, recorder.Body.String())
	}

	request = httptest.NewRequest(http.MethodPut, "/api/channels/bac-1/driver", strings.NewReader(`{"driver":"auto"}`))
	request.Header.Set("Content-Type", "application/json")
	recorder = httptest.NewRecorder()
	server.Handler().ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("unexpected auto response: status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	if _, ok := server.cfg().Channels[0].Params["driver"]; ok {
		t.Fatalf("auto switch did not remove explicit driver: %#v", server.cfg().Channels[0].Params)
	}
}

func TestWriteTagRejectsMissingOrStructuredValue(t *testing.T) {
	engine := acquisition.NewEngine(nil, nil, nil)
	server := NewServer(config.Config{}, engine)
	for _, body := range []string{`{}`, `{"value":null}`, `{"value":[]}`} {
		req := httptest.NewRequest(http.MethodPost, "/api/tags/tag-1/write", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		recorder := httptest.NewRecorder()
		server.Handler().ServeHTTP(recorder, req)
		if recorder.Code != http.StatusBadRequest {
			t.Fatalf("body=%s status=%d", body, recorder.Code)
		}
	}
}

func TestSecurityProtectsSensitiveEndpointsAndAuditsWrites(t *testing.T) {
	driver := &writeDriver{}
	engine := acquisition.NewEngine(
		[]acquisition.Channel{{ID: "ch-1", Enabled: true}},
		[]acquisition.Tag{{ID: "tag-1", ChannelID: "ch-1"}},
		func(_ acquisition.Channel, _ []acquisition.Tag, _ func(acquisition.Sample), _ func(acquisition.ChannelStatus)) acquisition.Driver {
			return driver
		},
	)
	if err := engine.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	defer engine.Stop(context.Background())

	auditPath := filepath.Join(t.TempDir(), "audit.jsonl")
	server := NewServerWithSecurity(config.Config{}, engine, "secret-token", audit.New(auditPath))
	handler := server.Handler()

	request := httptest.NewRequest(http.MethodGet, "/api/health", nil)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("health status=%d", response.Code)
	}

	request = httptest.NewRequest(http.MethodGet, "/api/channels", nil)
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated channels status=%d", response.Code)
	}

	request = httptest.NewRequest(http.MethodPost, "/api/tags/tag-1/write", strings.NewReader(`{"value":7}`))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Authorization", "Bearer secret-token")
	request.Header.Set("X-User", "operator-1")
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"ok":true`) {
		t.Fatalf("authenticated write status=%d body=%s", response.Code, response.Body.String())
	}

	b, err := os.ReadFile(auditPath)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(b), `"actor":"operator-1"`) || !strings.Contains(string(b), `"action":"tag.write"`) {
		t.Fatalf("audit record missing actor/action: %s", b)
	}
}

func TestCORSAllowlistAndAuthFailureRateLimit(t *testing.T) {
	server := NewServerWithOptions(config.Config{}, acquisition.NewEngine(nil, nil, nil), SecurityOptions{
		Token:         "secret-token",
		CORSOrigins:   []string{"http://localhost:3000"},
		FailureLimit:  2,
		FailureWindow: time.Hour,
	})
	handler := server.Handler()

	request := httptest.NewRequest(http.MethodGet, "/api/health", nil)
	request.Header.Set("Origin", "http://localhost:3000")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Header().Get("Access-Control-Allow-Origin") != "http://localhost:3000" {
		t.Fatalf("missing allowed CORS header: %v", response.Header())
	}
	request = httptest.NewRequest(http.MethodOptions, "/api/channels/demo/driver", nil)
	request.Header.Set("Origin", "http://localhost:3000")
	request.Header.Set("Access-Control-Request-Method", http.MethodPut)
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusNoContent || !strings.Contains(response.Header().Get("Access-Control-Allow-Methods"), http.MethodPut) {
		t.Fatalf("PUT preflight not allowed: status=%d headers=%v", response.Code, response.Header())
	}

	request = httptest.NewRequest(http.MethodOptions, "/api/channels", nil)
	request.Header.Set("Origin", "http://evil.example")
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusForbidden {
		t.Fatalf("disallowed preflight status=%d", response.Code)
	}

	for attempt := 0; attempt < 3; attempt++ {
		request = httptest.NewRequest(http.MethodGet, "/api/channels", nil)
		request.RemoteAddr = "192.0.2.10:1234"
		request.Header.Set("Authorization", "Bearer wrong")
		response = httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		want := http.StatusUnauthorized
		if attempt == 2 {
			want = http.StatusTooManyRequests
		}
		if response.Code != want {
			t.Fatalf("attempt=%d status=%d want=%d", attempt, response.Code, want)
		}
	}
}

func TestRBACSeparatesViewerAndOperator(t *testing.T) {
	server := NewServerWithOptions(config.Config{}, acquisition.NewEngine(nil, nil, nil), SecurityOptions{
		ViewerToken:   "viewer-token",
		OperatorToken: "operator-token",
	})
	handler := server.Handler()

	request := httptest.NewRequest(http.MethodGet, "/api/channels", nil)
	request.Header.Set("Authorization", "Bearer viewer-token")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("viewer read status=%d body=%s", response.Code, response.Body.String())
	}

	request = httptest.NewRequest(http.MethodPost, "/api/tags/tag-1/write", strings.NewReader(`{"value":1}`))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Authorization", "Bearer viewer-token")
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusForbidden {
		t.Fatalf("viewer write status=%d body=%s", response.Code, response.Body.String())
	}
}

func TestPasswordLoginCreatesAndRevokesSession(t *testing.T) {
	server := NewServerWithOptions(config.Config{}, acquisition.NewEngine(nil, nil, nil), SecurityOptions{
		LoginUsername: "admin",
		LoginPassword: "correct-password",
	})
	handler := server.Handler()

	request := httptest.NewRequest(http.MethodPost, "/api/auth/login", strings.NewReader(`{"username":"admin","password":"correct-password"}`))
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("login status=%d body=%s", response.Code, response.Body.String())
	}
	var loginResponse struct {
		Token string `json:"token"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &loginResponse); err != nil || loginResponse.Token == "" {
		t.Fatalf("invalid login response: %s", response.Body.String())
	}

	request = httptest.NewRequest(http.MethodGet, "/api/channels", nil)
	request.Header.Set("Authorization", "Bearer "+loginResponse.Token)
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("session read status=%d body=%s", response.Code, response.Body.String())
	}

	request = httptest.NewRequest(http.MethodPost, "/api/auth/logout", nil)
	request.Header.Set("Authorization", "Bearer "+loginResponse.Token)
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("logout status=%d", response.Code)
	}

	request = httptest.NewRequest(http.MethodGet, "/api/channels", nil)
	request.Header.Set("Authorization", "Bearer "+loginResponse.Token)
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("revoked session status=%d", response.Code)
	}
}

func TestPasswordLoginAcceptsBcryptHash(t *testing.T) {
	hash, err := bcrypt.GenerateFromPassword([]byte("hashed-password"), bcrypt.MinCost)
	if err != nil {
		t.Fatal(err)
	}
	server := NewServerWithOptions(config.Config{}, acquisition.NewEngine(nil, nil, nil), SecurityOptions{
		LoginUsername:     "admin",
		LoginPasswordHash: string(hash),
	})
	request := httptest.NewRequest(http.MethodPost, "/api/auth/login", strings.NewReader(`{"username":"admin","password":"hashed-password"}`))
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	server.Handler().ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("hash login status=%d body=%s", response.Code, response.Body.String())
	}
}

func TestFirstLoginRequiresPasswordChange(t *testing.T) {
	server := NewServerWithOptions(config.Config{}, acquisition.NewEngine(nil, nil, nil), SecurityOptions{
		LoginUsername:      "admin",
		LoginPassword:      "initial-password",
		PasswordFile:       filepath.Join(t.TempDir(), "auth.json"),
		MustChangePassword: true,
	})
	handler := server.Handler()
	request := httptest.NewRequest(http.MethodPost, "/api/auth/login", strings.NewReader(`{"username":"admin","password":"initial-password"}`))
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("first login status=%d body=%s", response.Code, response.Body.String())
	}
	var loginResponse struct {
		Token      string `json:"token"`
		MustChange bool   `json:"mustChangePassword"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &loginResponse); err != nil || !loginResponse.MustChange {
		t.Fatalf("must-change flag missing: %s", response.Body.String())
	}

	request = httptest.NewRequest(http.MethodGet, "/api/channels", nil)
	request.Header.Set("Authorization", "Bearer "+loginResponse.Token)
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusForbidden {
		t.Fatalf("protected endpoint before change status=%d", response.Code)
	}

	request = httptest.NewRequest(http.MethodPost, "/api/auth/password", strings.NewReader(`{"currentPassword":"initial-password","newPassword":"Strong-password-9!"}`))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Authorization", "Bearer "+loginResponse.Token)
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("password change status=%d body=%s", response.Code, response.Body.String())
	}

	request = httptest.NewRequest(http.MethodGet, "/api/channels", nil)
	request.Header.Set("Authorization", "Bearer "+loginResponse.Token)
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("protected endpoint after change status=%d", response.Code)
	}
}
