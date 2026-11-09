package api

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/factorybridge/iotconnector/gateway-go/internal/config"
	"github.com/factorybridge/iotconnector/gateway-go/internal/domain"
)

func secretConfig() config.Config {
	return config.Config{
		Channels: []domain.Channel{{ID: "opc-1", Name: "OPC", Protocol: "OPC UA", Host: "h", Port: 4840, Enabled: false,
			Params: map[string]any{"username": "u", "password": "opc-pass"}}},
		Tags: []domain.Tag{{ID: "t1", ChannelID: "opc-1", Name: "T1", Address: "ns=2;s=x"}},
		Raw: map[string]any{
			"northbound":    map[string]any{"enabled": false, "url": "mqtt://b:1883", "username": "nb", "password": "nb-pass"},
			"notifications": map[string]any{"enabled": false, "dingtalk": map[string]any{"secret": "ding-secret", "webhookUrl": "https://oapi.dingtalk.com/robot/send?access_token=tok"}},
		},
	}
}

var plainSecrets = []string{"opc-pass", "nb-pass", "ding-secret", "access_token=tok"}

func TestConfigBackupOmitsSecretsByDefault(t *testing.T) {
	server, _ := newOpsServer(t, secretConfig())
	res := call(server.Handler(), "GET", "/api/system/config-backup", "t", "")
	if res.Code != http.StatusOK {
		t.Fatalf("status %d: %s", res.Code, res.Body.String())
	}
	body := res.Body.String()
	for _, secret := range plainSecrets {
		if strings.Contains(body, secret) {
			t.Fatalf("backup leaks %q: %s", secret, body)
		}
	}
	var out struct {
		SecretsOmitted bool           `json:"secretsOmitted"`
		Config         map[string]any `json:"config"`
	}
	if err := json.Unmarshal(res.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	nb := out.Config["northbound"].(map[string]any)
	if !out.SecretsOmitted || nb["password"] != "" || nb["passwordSet"] != true || nb["username"] != "nb" {
		t.Fatalf("northbound in backup = %v (secretsOmitted=%v)", nb, out.SecretsOmitted)
	}
}

func TestConfigBackupIncludeSecretsIsExplicit(t *testing.T) {
	server, _ := newOpsServer(t, secretConfig())
	res := call(server.Handler(), "GET", "/api/system/config-backup?includeSecrets=1", "t", "")
	body := res.Body.String()
	for _, secret := range plainSecrets {
		if !strings.Contains(body, secret) {
			t.Fatalf("full backup missing %q", secret)
		}
	}
	if !strings.Contains(body, `"secretsOmitted":false`) {
		t.Fatalf("secretsOmitted flag: %s", body)
	}
}

// 同机恢复：备份里口令为空，恢复后沿用本机原值，不会被清空。
func TestConfigRestoreKeepsLocalSecretsFromRedactedBackup(t *testing.T) {
	server, store := newOpsServer(t, secretConfig())
	backup := call(server.Handler(), "GET", "/api/system/config-backup", "t", "").Body.String()
	res := call(server.Handler(), "POST", "/api/system/config-restore", "t", backup)
	if res.Code != http.StatusOK {
		t.Fatalf("restore %d: %s", res.Code, res.Body.String())
	}
	if !strings.Contains(res.Body.String(), `"secretsMissing":[]`) {
		t.Fatalf("unexpected missing secrets: %s", res.Body.String())
	}
	saved, err := store.Load()
	if err != nil {
		t.Fatal(err)
	}
	if saved.Channels[0].Params["password"] != "opc-pass" {
		t.Fatalf("channel password lost: %v", saved.Channels[0].Params)
	}
	nb := saved.Raw["northbound"].(map[string]any)
	ding := saved.Raw["notifications"].(map[string]any)["dingtalk"].(map[string]any)
	if nb["password"] != "nb-pass" || ding["secret"] != "ding-secret" || !strings.Contains(ding["webhookUrl"].(string), "tok") {
		t.Fatalf("raw secrets lost: nb=%v ding=%v", nb, ding)
	}
	if _, ok := nb["passwordSet"]; ok {
		t.Fatal("passwordSet marker must not be persisted")
	}
}

// 恢复到另一台（没有这些口令的）网关：口令留空，并在 secretsMissing 里列出。
func TestConfigRestoreReportsMissingSecretsOnNewGateway(t *testing.T) {
	source, _ := newOpsServer(t, secretConfig())
	backup := call(source.Handler(), "GET", "/api/system/config-backup", "t", "").Body.String()
	target, store := newOpsServer(t, config.Config{})
	res := call(target.Handler(), "POST", "/api/system/config-restore", "t", backup)
	if res.Code != http.StatusOK {
		t.Fatalf("restore %d: %s", res.Code, res.Body.String())
	}
	var out struct {
		SecretsMissing []string `json:"secretsMissing"`
	}
	if err := json.Unmarshal(res.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	joined := strings.Join(out.SecretsMissing, " ")
	for _, want := range []string{"channels[opc-1].params.password", "northbound.password", "notifications.dingtalk.secret", "notifications.dingtalk.webhookUrl"} {
		if !strings.Contains(joined, want) {
			t.Fatalf("secretsMissing = %v, want %s", out.SecretsMissing, want)
		}
	}
	saved, _ := store.Load()
	if saved.Raw["northbound"].(map[string]any)["password"] != "" {
		t.Fatal("missing secret should stay empty")
	}
}

// 完整备份（含口令）恢复时用备份里的值，不被本机值覆盖。
func TestConfigRestoreUsesSecretsFromFullBackup(t *testing.T) {
	source, _ := newOpsServer(t, secretConfig())
	backup := call(source.Handler(), "GET", "/api/system/config-backup?includeSecrets=1", "t", "").Body.String()
	other := secretConfig()
	other.Raw["northbound"].(map[string]any)["password"] = "local-pass"
	target, store := newOpsServer(t, other)
	if res := call(target.Handler(), "POST", "/api/system/config-restore", "t", backup); res.Code != http.StatusOK {
		t.Fatalf("restore %d", res.Code)
	}
	saved, _ := store.Load()
	if got := saved.Raw["northbound"].(map[string]any)["password"]; got != "nb-pass" {
		t.Fatalf("northbound password = %v, want value from backup", got)
	}
}

func newOpsServer(t *testing.T, cfg config.Config) (*Server, *config.Store) {
	t.Helper()
	store := config.NewStore(t.TempDir())
	if err := store.Save(cfg); err != nil {
		t.Fatal(err)
	}
	return systemOpsServer(t, cfg, &store), &store
}
