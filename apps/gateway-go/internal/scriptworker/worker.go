package scriptworker

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"strings"
	"time"

	"github.com/dop251/goja"
)

const (
	maxRequestBytes    = 256 * 1024
	maxCodeBytes       = 64 * 1024
	maxOutputBytes     = 64 * 1024
	maxOutputLineBytes = 2 * 1024
	maxWrites          = 50
	maxWriteValueBytes = 4 * 1024
)

type Request struct {
	Code   string            `json:"code"`
	Values map[string]any    `json:"values"`
	Tags   map[string]string `json:"tags"`
}

type Write struct {
	TagID string `json:"tagId"`
	Value any    `json:"value"`
}
type Response struct {
	OK         bool     `json:"ok"`
	Outputs    []string `json:"outputs"`
	Writes     []Write  `json:"writes"`
	Error      string   `json:"error,omitempty"`
	DurationMs int64    `json:"durationMs"`
}

func Run() error {
	input, err := io.ReadAll(io.LimitReader(os.Stdin, maxRequestBytes+1))
	if err != nil {
		return err
	}
	if len(input) > maxRequestBytes {
		return fmt.Errorf("script request exceeds %d bytes", maxRequestBytes)
	}
	var request Request
	if err := json.Unmarshal(input, &request); err != nil {
		return err
	}
	if len([]byte(request.Code)) > maxCodeBytes {
		return fmt.Errorf("script code exceeds %d bytes", maxCodeBytes)
	}
	start := time.Now()
	runtime := goja.New()
	outputs := []string{}
	outputBytes := 0
	writes := []Write{}
	appendOutput := func(value string) {
		if len(outputs) >= 50 || outputBytes >= maxOutputBytes {
			return
		}
		if len([]byte(value)) > maxOutputLineBytes {
			value = string([]byte(value)[:maxOutputLineBytes]) + "..."
		}
		remaining := maxOutputBytes - outputBytes
		if len([]byte(value)) > remaining {
			value = string([]byte(value)[:remaining])
		}
		if value == "" {
			return
		}
		outputs = append(outputs, value)
		outputBytes += len([]byte(value))
	}
	read := func(key string) any {
		value, ok := request.Values[key]
		if !ok {
			panic(runtime.ToValue("Read: tag has no value"))
		}
		return value
	}
	runtime.Set("Read", read)
	runtime.Set("Write", func(key string, value any) {
		tagID, ok := request.Tags[key]
		if !ok {
			panic(runtime.ToValue("Write: tag not found"))
		}
		if len(writes) >= maxWrites {
			panic(runtime.ToValue("Write: too many writes"))
		}
		encoded, err := json.Marshal(value)
		if err != nil || len(encoded) > maxWriteValueBytes {
			panic(runtime.ToValue("Write: value exceeds resource limit"))
		}
		writes = append(writes, Write{TagID: tagID, Value: value})
		appendOutput(fmt.Sprintf("Write %s = %v", key, value))
	})
	logFn := func(args ...any) {
		parts := make([]string, len(args))
		for i, arg := range args {
			parts[i] = fmt.Sprint(arg)
		}
		appendOutput(strings.Join(parts, " "))
	}
	runtime.Set("log", logFn)
	runtime.Set("console", map[string]any{"log": logFn})
	timer := time.AfterFunc(time.Second, func() { runtime.Interrupt("script timeout") })
	_, runErr := runtime.RunString(request.Code)
	timer.Stop()
	response := Response{OK: runErr == nil, Outputs: outputs, Writes: writes, DurationMs: time.Since(start).Milliseconds()}
	if runErr != nil {
		response.Error = runErr.Error()
	}
	return json.NewEncoder(os.Stdout).Encode(response)
}
