package acquisition

import "testing"

func TestDecodeMQTTValue(t *testing.T) {
	tests := []struct {
		name string
		body string
		typ  string
		want string
	}{
		{name: "number", body: "12.5", typ: "Float", want: "12.5"},
		{name: "json number", body: `{"value":13.25}`, typ: "Float", want: "13.25"},
		{name: "bool", body: "true", typ: "Bool", want: "true"},
		{name: "json bool", body: `{"value":false}`, typ: "Bool", want: "false"},
		{name: "string", body: `"RUN"`, typ: "String", want: "RUN"},
		{name: "json string", body: `{"value":"IDLE"}`, typ: "String", want: "IDLE"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			value, ok := decodeMQTTValue([]byte(tt.body), tt.typ)
			if !ok {
				t.Fatalf("decode failed for %s", tt.body)
			}
			got := ""
			switch {
			case value.Number != nil:
				got = formatTestFloat(*value.Number)
			case value.Bool != nil:
				if *value.Bool {
					got = "true"
				} else {
					got = "false"
				}
			case value.String != nil:
				got = *value.String
			}
			if got != tt.want {
				t.Fatalf("value=%q want %q", got, tt.want)
			}
		})
	}
}

func TestMQTTValueToJSON(t *testing.T) {
	number := 12.5
	boolean := true
	text := "RUN"
	checks := []struct {
		value Value
		want  string
	}{
		{NumberValue(number), "12.5"},
		{BoolValue(boolean), "true"},
		{StringValue(text), `"RUN"`},
	}
	for _, check := range checks {
		if got := string(valueToJSON(check.value)); got != check.want {
			t.Fatalf("payload=%q want %q", got, check.want)
		}
	}
}

func TestDecodeMQTTValuePath(t *testing.T) {
	value, ok := decodeMQTTValuePath([]byte(`{"temp":42.5,"running":true}`), "Float", "temp")
	if !ok || value.Number == nil || *value.Number != 42.5 {
		t.Fatalf("unexpected temp value: %+v", value)
	}
	value, ok = decodeMQTTValuePath([]byte(`{"temp":42.5,"running":true}`), "Bool", "running")
	if !ok || value.Bool == nil || !*value.Bool {
		t.Fatalf("unexpected running value: %+v", value)
	}
}

func formatTestFloat(value float64) string {
	return string(valueToJSON(NumberValue(value)))
}
