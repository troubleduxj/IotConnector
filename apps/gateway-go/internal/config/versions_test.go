package config

import (
	"context"
	"os"
	"strings"
	"testing"

	"github.com/factorybridge/iotconnector/gateway-go/internal/db"
	"github.com/factorybridge/iotconnector/gateway-go/internal/domain"
)

func openTestDB(t *testing.T) (*db.DB, string) {
	t.Helper()
	dir := t.TempDir()
	database, err := db.Open(context.Background(), dir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { database.Close() })
	return database, dir
}

func sampleConfig(name string) Config {
	return Config{
		Channels: []domain.Channel{{ID: "c1", Name: name, Protocol: "Modbus TCP", Host: "h", Port: 502}},
		Tags:     []domain.Tag{{ID: "t1", ChannelID: "c1", Name: "T1", Address: "40001"}},
		Raw:      map[string]any{"northbound": map[string]any{"enabled": false}},
	}
}

// 首次启动：库为空，导入现有 config.json 为版本 1，并保留文件。
func TestFirstStartImportsConfigJSON(t *testing.T) {
	database, dir := openTestDB(t)
	legacy := NewStore(dir)
	if err := legacy.Save(sampleConfig("from-file")); err != nil {
		t.Fatal(err)
	}
	store := NewStoreDB(dir, database)
	cfg, err := store.Load()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Channels[0].Name != "from-file" {
		t.Fatalf("loaded %+v", cfg.Channels)
	}
	versions, err := store.Versions(context.Background(), 10)
	if err != nil || len(versions) != 1 || versions[0].Actor != "import:config.json" {
		t.Fatalf("versions = %+v, %v", versions, err)
	}
	if _, err := os.Stat(store.Path); err != nil {
		t.Fatal("config.json must be kept")
	}
}

// 保存：每次一个新版本，config.json 同步为镜像；内容不变不新增版本。
func TestSaveAddsVersionsAndMirrorsFile(t *testing.T) {
	database, dir := openTestDB(t)
	store := NewStoreDB(dir, database)
	if _, err := store.Load(); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"a", "b", "b"} {
		if err := store.SaveAs(sampleConfig(name), "alice"); err != nil {
			t.Fatal(err)
		}
	}
	versions, _ := store.Versions(context.Background(), 10)
	// 版本 1 是首次 Load 导入的空配置；a、b 各一个；第二个 b 内容相同不新增。
	if len(versions) != 3 || versions[0].Actor != "alice" {
		t.Fatalf("versions = %+v", versions)
	}
	data, _ := os.ReadFile(store.Path)
	if !strings.Contains(string(data), `"name": "b"`) {
		t.Fatalf("mirror not updated: %s", data)
	}
	// 重新打开时以库中最新版本为准。
	reopened := NewStoreDB(dir, database)
	cfg, err := reopened.Load()
	if err != nil || cfg.Channels[0].Name != "b" {
		t.Fatalf("reload = %+v, %v", cfg.Channels, err)
	}
}

// 停机时手改 config.json：下次启动导入为新版本，而不是被库里的旧版本覆盖。
func TestHandEditedConfigJSONIsImported(t *testing.T) {
	database, dir := openTestDB(t)
	store := NewStoreDB(dir, database)
	if _, err := store.Load(); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveAs(sampleConfig("db"), "api"); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(store.Path, []byte(`{"schemaVersion":2,"channels":[{"id":"c1","name":"hand-edited","protocol":"Modbus TCP","host":"h","port":502}],"tags":[]}`), 0o640); err != nil {
		t.Fatal(err)
	}
	reopened := NewStoreDB(dir, database)
	cfg, err := reopened.Load()
	if err != nil || cfg.Channels[0].Name != "hand-edited" {
		t.Fatalf("hand edit lost: %+v, %v", cfg.Channels, err)
	}
	if !reopened.ImportedEditedFile() {
		t.Fatal("caller should be told the file was imported")
	}
	versions, _ := reopened.Versions(context.Background(), 10)
	if versions[0].Actor != "import:config.json" {
		t.Fatalf("newest version actor = %q", versions[0].Actor)
	}
}

// 镜像文件缺失或损坏：以库为准，并重写镜像。
func TestMissingMirrorIsRewrittenFromDB(t *testing.T) {
	database, dir := openTestDB(t)
	store := NewStoreDB(dir, database)
	_, _ = store.Load()
	if err := store.SaveAs(sampleConfig("kept"), "api"); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(store.Path); err != nil {
		t.Fatal(err)
	}
	reopened := NewStoreDB(dir, database)
	cfg, err := reopened.Load()
	if err != nil || cfg.Channels[0].Name != "kept" {
		t.Fatalf("load = %+v, %v", cfg.Channels, err)
	}
	if _, err := os.Stat(store.Path); err != nil {
		t.Fatal("mirror should be rewritten")
	}
}

func TestVersionExportAndPruning(t *testing.T) {
	database, dir := openTestDB(t)
	store := NewStoreDB(dir, database)
	_, _ = store.Load()
	store.keepVersions = 3
	for i := 0; i < 5; i++ {
		if err := store.SaveAs(sampleConfig(string(rune('a'+i))), "api"); err != nil {
			t.Fatal(err)
		}
	}
	versions, _ := store.Versions(context.Background(), 10)
	if len(versions) != 3 {
		t.Fatalf("kept %d versions, want 3", len(versions))
	}
	// 导入的空配置是 v1，之后 a..e 依次为 v2..v6；只保留最近 3 个，即 v4..v6（c、d、e）。
	oldest := versions[len(versions)-1].Version
	body, err := store.VersionBody(context.Background(), oldest)
	if err != nil || oldest != 4 || !strings.Contains(body, `"name": "c"`) {
		t.Fatalf("oldest kept version v%d: %v %s", oldest, err, body)
	}
	if _, err := store.VersionBody(context.Background(), 1); err == nil {
		t.Fatal("pruned version should not be exportable")
	}
}
