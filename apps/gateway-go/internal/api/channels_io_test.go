package api

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/factorybridge/iotconnector/gateway-go/internal/acquisition"
	"github.com/factorybridge/iotconnector/gateway-go/internal/config"
	"github.com/factorybridge/iotconnector/gateway-go/internal/domain"
)

const channelIOToken = "t"

func newChannelIOServer(t *testing.T) *Server {
	t.Helper()
	cfg := config.Config{
		Channels: []domain.Channel{{
			ID: "ch-1", Name: "PLC A", Protocol: "modbus", Host: "10.0.0.1", Port: 502,
			Enabled: true, PollIntervalMs: 1000,
			Params: map[string]any{"password": "secret-x"},
		}, {
			ID: "ch-2", Name: "PLC B", Protocol: "modbus", Host: "10.0.0.2", Port: 502,
		}},
		Tags: []domain.Tag{
			{ID: "t-1", ChannelID: "ch-1", Name: "temp", Address: "40001"},
			{ID: "t-2", ChannelID: "ch-1", Name: "press", Address: "40002"},
			{ID: "t-3", ChannelID: "ch-2", Name: "flow", Address: "40003"},
		},
		Raw: map[string]any{"northbound": map[string]any{"password": "diag-secret-y"}},
	}
	engine := acquisition.NewEngine(nil, nil, nil)
	return NewServerWithOptions(cfg, engine, SecurityOptions{AdminToken: channelIOToken})
}

func authedRequest(method, path, body string) *http.Request {
	request := newJSONRequest(method, path, body)
	request.Header.Set("Authorization", "Bearer "+channelIOToken)
	return request
}

func decodeBody(t *testing.T, body []byte) map[string]any {
	t.Helper()
	var out map[string]any
	if err := json.Unmarshal(body, &out); err != nil {
		t.Fatalf("decode body: %v: %s", err, body)
	}
	return out
}

func TestExportChannelReturnsBundleWithoutSecrets(t *testing.T) {
	server := newChannelIOServer(t)
	handler := server.Handler()

	response := serve(handler, authedRequest(http.MethodGet, "/api/channels/ch-1/export", ""))
	if response.Code != http.StatusOK {
		t.Fatalf("status %d: %s", response.Code, response.Body.String())
	}
	body := response.Body.String()
	if strings.Contains(body, "secret-x") {
		t.Fatalf("export leaked password: %s", body)
	}
	bundle := decodeBody(t, response.Body.Bytes())
	if bundle["format"] != "factorybridge-channel@1" {
		t.Fatalf("format = %v", bundle["format"])
	}
	tags, _ := bundle["tags"].([]any)
	if len(tags) != 2 {
		t.Fatalf("expected 2 tags for ch-1, got %d", len(tags))
	}
	for _, item := range tags {
		if item.(map[string]any)["channelId"] != "ch-1" {
			t.Fatalf("tag from another channel: %v", item)
		}
	}
	if disposition := response.Header().Get("Content-Disposition"); disposition != `attachment; filename="PLC_A.channel.json"` {
		t.Fatalf("Content-Disposition = %q", disposition)
	}
}

func TestExportUnknownChannelReturns404(t *testing.T) {
	server := newChannelIOServer(t)
	response := serve(server.Handler(), authedRequest(http.MethodGet, "/api/channels/missing/export", ""))
	if response.Code != http.StatusNotFound {
		t.Fatalf("status %d: %s", response.Code, response.Body.String())
	}
	body := decodeBody(t, response.Body.Bytes())
	if body["error"] != "channel not found" || body["ok"] != false {
		t.Fatalf("unexpected body: %v", body)
	}
}

func TestImportChannelRoundTrip(t *testing.T) {
	server := newChannelIOServer(t)
	handler := server.Handler()

	export := serve(handler, authedRequest(http.MethodGet, "/api/channels/ch-1/export", ""))
	bundle := decodeBody(t, export.Body.Bytes())

	// Same name is a duplicate.
	raw, _ := json.Marshal(bundle)
	duplicate := serve(handler, authedRequest(http.MethodPost, "/api/channels/import", string(raw)))
	if duplicate.Code != http.StatusConflict {
		t.Fatalf("duplicate import status %d: %s", duplicate.Code, duplicate.Body.String())
	}

	// Renaming makes the import succeed with fresh IDs.
	channel := bundle["channel"].(map[string]any)
	channel["name"] = "PLC A copy"
	raw, _ = json.Marshal(bundle)
	created := serve(handler, authedRequest(http.MethodPost, "/api/channels/import", string(raw)))
	if created.Code != http.StatusCreated {
		t.Fatalf("import status %d: %s", created.Code, created.Body.String())
	}
	result := decodeBody(t, created.Body.Bytes())
	newChannel := result["channel"].(map[string]any)
	newID, _ := newChannel["id"].(string)
	if newID == "" || newID == "ch-1" {
		t.Fatalf("expected fresh channel id, got %q", newID)
	}
	if result["importedTags"] != float64(2) {
		t.Fatalf("importedTags = %v", result["importedTags"])
	}

	current := server.cfg()
	if len(current.Channels) != 3 {
		t.Fatalf("channels = %d, want 3", len(current.Channels))
	}
	imported := 0
	for _, tag := range current.Tags {
		if tag.ChannelID == newID {
			imported++
			if !strings.HasPrefix(tag.ID, "tag_") {
				t.Fatalf("tag id %q lacks tag_ prefix", tag.ID)
			}
		}
	}
	if imported != 2 {
		t.Fatalf("imported tags = %d, want 2", imported)
	}
}

func TestImportChannelMissingProtocolReturns400(t *testing.T) {
	server := newChannelIOServer(t)
	body := `{"channel":{"name":"New","host":"10.0.0.9","port":502}}`
	response := serve(server.Handler(), authedRequest(http.MethodPost, "/api/channels/import", body))
	if response.Code != http.StatusBadRequest {
		t.Fatalf("status %d: %s", response.Code, response.Body.String())
	}
	result := decodeBody(t, response.Body.Bytes())
	if result["error"] != "channel.name & channel.protocol required" {
		t.Fatalf("unexpected body: %v", result)
	}
}

func TestImportChannelTagWithoutAddressReturns400WithDetails(t *testing.T) {
	server := newChannelIOServer(t)
	body := `{"channel":{"name":"New","protocol":"modbus","host":"10.0.0.9","port":502},"tags":[{"name":"ok","address":"1"},{"name":"bad"}]}`
	response := serve(server.Handler(), authedRequest(http.MethodPost, "/api/channels/import", body))
	if response.Code != http.StatusBadRequest {
		t.Fatalf("status %d: %s", response.Code, response.Body.String())
	}
	result := decodeBody(t, response.Body.Bytes())
	details, _ := result["details"].([]any)
	if len(details) != 1 {
		t.Fatalf("details = %v", result["details"])
	}
	if len(server.cfg().Channels) != 2 {
		t.Fatalf("rejected import must not persist a channel")
	}
}

func TestSystemDiagExcludesSecrets(t *testing.T) {
	server := newChannelIOServer(t)
	response := serve(server.Handler(), authedRequest(http.MethodGet, "/api/system/diag", ""))
	if response.Code != http.StatusOK {
		t.Fatalf("status %d: %s", response.Code, response.Body.String())
	}
	body := response.Body.String()
	if !strings.Contains(body, "build") {
		t.Fatalf("diag missing build info: %s", body)
	}
	if strings.Contains(body, "diag-secret-y") {
		t.Fatalf("diag leaked northbound password: %s", body)
	}
	if response.Header().Get("Content-Disposition") != `attachment; filename="factorybridge-diag.json"` {
		t.Fatalf("Content-Disposition = %q", response.Header().Get("Content-Disposition"))
	}
}

func TestOpenAPIDocListsImportRoute(t *testing.T) {
	server := newChannelIOServer(t)
	response := serve(server.Handler(), authedRequest(http.MethodGet, "/api/system/openapi.json", ""))
	if response.Code != http.StatusOK {
		t.Fatalf("status %d: %s", response.Code, response.Body.String())
	}
	doc := decodeBody(t, response.Body.Bytes())
	if doc["openapi"] != "3.0.3" {
		t.Fatalf("openapi = %v", doc["openapi"])
	}
	paths, _ := doc["paths"].(map[string]any)
	importPath, ok := paths["/api/channels/import"].(map[string]any)
	if !ok {
		t.Fatalf("missing /api/channels/import path")
	}
	if _, ok := importPath["post"]; !ok {
		t.Fatalf("missing post operation: %v", importPath)
	}
}
