package api

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/factorybridge/iotconnector/gateway-go/internal/acquisition"
)

func TestHistoryStorePersistsAndRecoversSamples(t *testing.T) {
	path := filepath.Join(t.TempDir(), "history.jsonl")
	store := newHistoryStore(path)
	store.add(acquisition.Sample{TagID: "tag-1", SampledAt: 1000, Value: acquisition.NumberValue(12.5)})
	store.add(acquisition.Sample{TagID: "tag-1", SampledAt: 2000, Value: acquisition.NumberValue(13.5)})
	store.add(acquisition.Sample{TagID: "bool-1", SampledAt: 2000, Value: acquisition.BoolValue(true)})

	recovered := newHistoryStore(path)
	points := recovered.query([]string{"tag-1"}, 0, 3000)["tag-1"]
	if len(points) != 2 || points[0].Value != 12.5 || points[1].Value != 13.5 {
		t.Fatalf("unexpected recovered history: %#v", points)
	}
	if _, err := os.Stat(path); err != nil {
		t.Fatal(err)
	}
}

func TestHistoryStoreSkipsMalformedLines(t *testing.T) {
	path := filepath.Join(t.TempDir(), "history.jsonl")
	if err := os.WriteFile(path, []byte("not-json\n{\"tagId\":\"tag-1\",\"ts\":1000,\"value\":7}\n"), 0o640); err != nil {
		t.Fatal(err)
	}
	store := newHistoryStore(path)
	points := store.query([]string{"tag-1"}, 0, 2000)["tag-1"]
	if len(points) != 1 || points[0].Value != 7 {
		t.Fatalf("malformed line affected recovery: %#v", points)
	}
}
