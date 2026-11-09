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

func systemOpsChannels() []domain.Channel {
	return []domain.Channel{
		{ID: "ch-1", Name: "PLC A", Protocol: "modbus-tcp", Host: "10.0.0.1", Port: 502, Enabled: true, PollIntervalMs: 1000},
		{ID: "ch-2", Name: "PLC B", Protocol: "modbus-tcp", Host: "10.0.0.2", Port: 502, Enabled: false, PollIntervalMs: 1000},
	}
}

func systemOpsTags() []domain.Tag {
	return []domain.Tag{{ID: "tag-1", ChannelID: "ch-1", Name: "Temp", Address: "40001", DataType: "float32"}}
}

func systemOpsServer(t *testing.T, cfg config.Config, store *config.Store) *Server {
	t.Helper()
	options := SecurityOptions{AdminToken: "t"}
	if store != nil {
		options.ConfigStore = store
	}
	return NewServerWithOptions(cfg, acquisition.NewEngine(nil, nil, nil), options)
}

func systemOpsSourceConfig() config.Config {
	return config.Config{
		SchemaVersion: config.CurrentSchemaVersion,
		Channels:      systemOpsChannels(),
		Tags:          systemOpsTags(),
		Raw: map[string]any{
			"northbound": map[string]any{"enabled": true, "password": "nb-secret-123"},
			"users":      []any{map[string]any{"username": "root", "passwordHash": "HASH-SHOULD-NOT-LEAK"}},
		},
	}
}

func TestConfigBackupReturnsFormatChannelsTagsAndHeader(t *testing.T) {
	server := systemOpsServer(t, systemOpsSourceConfig(), nil)
	handler := server.Handler()

	response := call(handler, "GET", "/api/system/config-backup", "t", "")
	if response.Code != http.StatusOK {
		t.Fatalf("backup status=%d body=%s", response.Code, response.Body.String())
	}
	if got := response.Header().Get("Content-Disposition"); got != `attachment; filename="factorybridge-config.json"` {
		t.Fatalf("Content-Disposition=%q", got)
	}
	body := response.Body.String()
	if strings.Contains(body, "passwordHash") || strings.Contains(body, "HASH-SHOULD-NOT-LEAK") {
		t.Fatalf("backup leaked password hash: %s", body)
	}

	var out struct {
		Format     string         `json:"format"`
		ExportedAt string         `json:"exportedAt"`
		Config     map[string]any `json:"config"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode backup: %v", err)
	}
	if out.Format != "factorybridge-config@1" {
		t.Fatalf("format=%q", out.Format)
	}
	if out.ExportedAt == "" {
		t.Fatal("exportedAt is empty")
	}
	channels, ok := out.Config["channels"].([]any)
	if !ok || len(channels) != 2 {
		t.Fatalf("config.channels=%v", out.Config["channels"])
	}
	tags, ok := out.Config["tags"].([]any)
	if !ok || len(tags) != 1 {
		t.Fatalf("config.tags=%v", out.Config["tags"])
	}
	if _, ok := out.Config["users"]; ok {
		t.Fatal("backup config must not contain users")
	}
	northbound, _ := out.Config["northbound"].(map[string]any)
	// 默认备份不含口令，只标记已设置（见 backup_secrets_test.go）。
	if northbound["password"] != "" || northbound["passwordSet"] != true {
		t.Fatalf("northbound password should be omitted from the default backup, got %v", northbound)
	}
}

func TestConfigRestoreRoundTripPersistsToStore(t *testing.T) {
	sourceServer := systemOpsServer(t, systemOpsSourceConfig(), nil)
	backup := call(sourceServer.Handler(), "GET", "/api/system/config-backup", "t", "")
	if backup.Code != http.StatusOK {
		t.Fatalf("backup status=%d", backup.Code)
	}
	var backupBody struct {
		Format string         `json:"format"`
		Config map[string]any `json:"config"`
	}
	if err := json.Unmarshal(backup.Body.Bytes(), &backupBody); err != nil {
		t.Fatalf("decode backup: %v", err)
	}
	restoreBody, err := json.Marshal(map[string]any{"format": backupBody.Format, "config": backupBody.Config})
	if err != nil {
		t.Fatal(err)
	}

	dir := t.TempDir()
	store := config.NewStore(dir)
	target := systemOpsServer(t, config.Config{Raw: map[string]any{}}, &store)
	response := call(target.Handler(), "POST", "/api/system/config-restore", "t", string(restoreBody))
	if response.Code != http.StatusOK {
		t.Fatalf("restore status=%d body=%s", response.Code, response.Body.String())
	}
	var out struct {
		OK     bool `json:"ok"`
		Counts struct {
			Channels int `json:"channels"`
			Tags     int `json:"tags"`
		} `json:"counts"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode restore: %v", err)
	}
	if !out.OK || out.Counts.Channels != 2 || out.Counts.Tags != 1 {
		t.Fatalf("restore response=%s", response.Body.String())
	}
	if got := len(target.cfg().Channels); got != len(sourceServer.cfg().Channels) {
		t.Fatalf("target channels=%d want %d", got, len(sourceServer.cfg().Channels))
	}

	reloaded, err := config.NewStore(dir).Load()
	if err != nil {
		t.Fatalf("reload store: %v", err)
	}
	if len(reloaded.Channels) != 2 || len(reloaded.Tags) != 1 {
		t.Fatalf("persisted channels=%d tags=%d", len(reloaded.Channels), len(reloaded.Tags))
	}
	if _, ok := reloaded.Raw["users"]; ok {
		t.Fatal("persisted config must not contain users")
	}
}

func TestConfigRestoreRejectsWrongFormat(t *testing.T) {
	server := systemOpsServer(t, config.Config{Raw: map[string]any{}}, nil)
	response := call(server.Handler(), "POST", "/api/system/config-restore", "t",
		`{"format":"other@9","config":{"channels":[],"tags":[]}}`)
	if response.Code != http.StatusBadRequest {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	if !strings.Contains(response.Body.String(), "factorybridge-config@1") {
		t.Fatalf("unexpected error body: %s", response.Body.String())
	}
}

func TestConfigRestoreRejectsNonArrayChannels(t *testing.T) {
	server := systemOpsServer(t, config.Config{Raw: map[string]any{}}, nil)
	response := call(server.Handler(), "POST", "/api/system/config-restore", "t",
		`{"format":"factorybridge-config@1","config":{"channels":{},"tags":[]}}`)
	if response.Code != http.StatusBadRequest {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
}

func TestConfigRestoreIgnoresUsersKey(t *testing.T) {
	server := systemOpsServer(t, config.Config{Raw: map[string]any{}}, nil)
	response := call(server.Handler(), "POST", "/api/system/config-restore", "t",
		`{"format":"factorybridge-config@1","config":{"channels":[],"tags":[],"users":[{"username":"evil","role":"admin"}]}}`)
	if response.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	if _, ok := server.cfg().Raw["users"]; ok {
		t.Fatal("users key must not be stored in config")
	}
}

func TestFactoryResetRequiresConfirm(t *testing.T) {
	server := systemOpsServer(t, systemOpsSourceConfig(), nil)
	handler := server.Handler()
	for _, body := range []string{`{}`, `{"confirm":"reset"}`, `{"confirm":"YES"}`} {
		response := call(handler, "POST", "/api/system/factory-reset", "t", body)
		if response.Code != http.StatusBadRequest {
			t.Fatalf("body %s: status=%d", body, response.Code)
		}
	}
	if len(server.cfg().Channels) != 2 {
		t.Fatal("config changed without confirm")
	}
}

func TestFactoryResetClearsConfigAndKeepsOtherKeysClean(t *testing.T) {
	server := systemOpsServer(t, systemOpsSourceConfig(), nil)
	response := call(server.Handler(), "POST", "/api/system/factory-reset", "t", `{"confirm":"RESET","purgeStorage":false}`)
	if response.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	var out struct {
		OK            bool `json:"ok"`
		StoragePurged bool `json:"storagePurged"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if !out.OK || out.StoragePurged {
		t.Fatalf("response=%s", response.Body.String())
	}
	cfg := server.cfg()
	if len(cfg.Channels) != 0 || len(cfg.Tags) != 0 {
		t.Fatalf("channels=%d tags=%d after reset", len(cfg.Channels), len(cfg.Tags))
	}
	notifications, _ := cfg.Raw["notifications"].(map[string]any)
	if notifications["enabled"] != false {
		t.Fatalf("notifications=%v", cfg.Raw["notifications"])
	}
	northbound, _ := cfg.Raw["northbound"].(map[string]any)
	if northbound["enabled"] != false {
		t.Fatalf("northbound=%v", cfg.Raw["northbound"])
	}
	if _, ok := cfg.Raw["users"]; ok {
		t.Fatal("users key must not be written by factory reset")
	}
}

func TestRebalanceSchedulerReturnsEnabledCount(t *testing.T) {
	server := systemOpsServer(t, systemOpsSourceConfig(), nil)
	response := call(server.Handler(), "POST", "/api/scheduler/rebalance", "t", "")
	if response.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	var out struct {
		OK       bool `json:"ok"`
		Reloaded int  `json:"reloaded"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if !out.OK || out.Reloaded != 1 {
		t.Fatalf("response=%s", response.Body.String())
	}
}
