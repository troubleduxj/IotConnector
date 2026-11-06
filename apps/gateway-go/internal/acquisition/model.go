package acquisition

import "context"

type Quality string

const (
	QualityGood      Quality = "Good"
	QualityUncertain Quality = "Uncertain"
	QualityBad       Quality = "Bad"
)

type Value struct {
	Number *float64
	String *string
	Bool   *bool
}

func NumberValue(v float64) Value { return Value{Number: &v} }
func StringValue(v string) Value  { return Value{String: &v} }
func BoolValue(v bool) Value      { return Value{Bool: &v} }

type Sample struct {
	TagID      string  `json:"id"`
	Value      Value   `json:"value"`
	Quality    Quality `json:"quality"`
	SampledAt  int64   `json:"ts"`
	ReceivedAt int64   `json:"receivedTs"`
}

type Tag struct {
	ID        string
	ChannelID string
	Name      string
	Address   string
	DataType  string
	Scale     float64
	Offset    float64
}

type Channel struct {
	ID             string
	Protocol       string
	Host           string
	Port           int
	PollIntervalMs int
	Enabled        bool
	Params         map[string]any
}

type ChannelStatus struct {
	ID     string `json:"id"`
	State  string `json:"state"`
	Detail string `json:"detail,omitempty"`
}

// Driver is the first stable boundary for protocol migration. Implementations
// must honor context cancellation and return without blocking from Stop.
type Driver interface {
	Start(context.Context) error
	Stop(context.Context) error
	Read(context.Context, []Tag) ([]Sample, error)
	Write(context.Context, Tag, Value) error
	Test(context.Context, []Tag) error
}

type DriverFactory func(Channel, []Tag, func(Sample), func(ChannelStatus)) Driver
