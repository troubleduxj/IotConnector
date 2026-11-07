package config

import (
	"testing"

	"github.com/factorybridge/iotconnector/gateway-go/internal/domain"
)

func TestCloneIsDeep(t *testing.T) {
	low := 1.0
	original := Config{
		SchemaVersion: 2,
		Channels:      []domain.Channel{{ID: "c1", Params: map[string]any{"driver": "go", "nested": map[string]any{"k": "v"}}}},
		Tags:          []domain.Tag{{ID: "t1", EngMin: &low}},
		Raw: map[string]any{
			"notifications": map[string]any{"email": map[string]any{"password": "p"}},
			"recipes":       []any{map[string]any{"id": "r1"}},
		},
	}
	clone := original.Clone()

	clone.Channels[0].Params["driver"] = "node"
	clone.Channels[0].Params["nested"].(map[string]any)["k"] = "changed"
	*clone.Tags[0].EngMin = 99
	clone.Raw["notifications"].(map[string]any)["email"].(map[string]any)["password"] = "changed"
	clone.Raw["recipes"].([]any)[0].(map[string]any)["id"] = "changed"
	clone.Channels = append(clone.Channels, domain.Channel{ID: "c2"})

	if original.Channels[0].Params["driver"] != "go" ||
		original.Channels[0].Params["nested"].(map[string]any)["k"] != "v" ||
		*original.Tags[0].EngMin != 1 ||
		original.Raw["notifications"].(map[string]any)["email"].(map[string]any)["password"] != "p" ||
		original.Raw["recipes"].([]any)[0].(map[string]any)["id"] != "r1" ||
		len(original.Channels) != 1 {
		t.Fatalf("Clone shares state with original: %#v", original)
	}
}

func TestCloneOfEmptyConfig(t *testing.T) {
	clone := Config{}.Clone()
	if clone.Raw != nil || clone.Channels != nil || clone.Tags != nil {
		t.Fatalf("empty clone = %#v", clone)
	}
}
