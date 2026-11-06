package domain

// Channel is the compatibility subset of the existing TypeScript channel model.
type Channel struct {
	ID             string         `json:"id"`
	Name           string         `json:"name"`
	Protocol       string         `json:"protocol"`
	Host           string         `json:"host"`
	Port           int            `json:"port"`
	Enabled        bool           `json:"enabled"`
	PollIntervalMs int            `json:"pollIntervalMs"`
	Params         map[string]any `json:"params"`
}

// Tag is the compatibility subset used by the initial health and config loader.
type Tag struct {
	ID        string   `json:"id"`
	ChannelID string   `json:"channelId"`
	Name      string   `json:"name"`
	Address   string   `json:"address"`
	DataType  string   `json:"dataType"`
	Unit      string   `json:"unit"`
	Scale     float64  `json:"scale"`
	Offset    float64  `json:"offset"`
	EngMin    *float64 `json:"engMin,omitempty"`
	EngMax    *float64 `json:"engMax,omitempty"`
}
