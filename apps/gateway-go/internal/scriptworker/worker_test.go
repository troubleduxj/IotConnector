package scriptworker

import (
	"bytes"
	"encoding/json"
	"os"
	"strings"
	"testing"
)

func runRequest(t *testing.T, request Request) Response {
	t.Helper()
	encoded, err := json.Marshal(request)
	if err != nil {
		t.Fatal(err)
	}
	oldStdin := os.Stdin
	input, err := os.CreateTemp(t.TempDir(), "script-input-*.json")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := input.Write(encoded); err != nil {
		t.Fatal(err)
	}
	if _, err := input.Seek(0, 0); err != nil {
		t.Fatal(err)
	}
	os.Stdin = input
	defer func() { os.Stdin = oldStdin; _ = input.Close() }()

	oldStdout := os.Stdout
	outRead, outWrite, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	os.Stdout = outWrite
	err = Run()
	_ = outWrite.Close()
	os.Stdout = oldStdout
	if err != nil {
		return Response{Error: err.Error()}
	}
	var response Response
	if err := json.NewDecoder(outRead).Decode(&response); err != nil {
		t.Fatal(err)
	}
	_ = outRead.Close()
	return response
}

func TestRunLimitsCodeAndOutput(t *testing.T) {
	response := runRequest(t, Request{Code: "log('" + strings.Repeat("x", maxOutputLineBytes+100) + "')"})
	if !response.OK || len(response.Outputs) != 1 {
		t.Fatalf("unexpected response: %+v", response)
	}
	if len([]byte(response.Outputs[0])) > maxOutputLineBytes+3 {
		t.Fatalf("output line was not bounded: %d", len([]byte(response.Outputs[0])))
	}

	tooLarge := Request{Code: strings.Repeat("x", maxCodeBytes+1)}
	encoded, _ := json.Marshal(tooLarge)
	if len(encoded) > maxRequestBytes {
		t.Skip("request-size limit is exercised before code-size limit")
	}
	response = runRequest(t, tooLarge)
	if response.OK || !strings.Contains(response.Error, "code exceeds") {
		t.Fatalf("expected code limit error: %+v", response)
	}
}

func TestRunRejectsLargeRequest(t *testing.T) {
	request := Request{Code: "1", Values: map[string]any{"payload": strings.Repeat("x", maxRequestBytes)}}
	encoded, _ := json.Marshal(request)
	if len(encoded) <= maxRequestBytes {
		t.Fatal("test request did not exceed request limit")
	}
	oldStdin := os.Stdin
	input, err := os.CreateTemp(t.TempDir(), "script-input-*.json")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := input.Write(bytes.Clone(encoded)); err != nil {
		t.Fatal(err)
	}
	if _, err := input.Seek(0, 0); err != nil {
		t.Fatal(err)
	}
	os.Stdin = input
	defer func() { os.Stdin = oldStdin; _ = input.Close() }()
	if err := Run(); err == nil || !strings.Contains(err.Error(), "request exceeds") {
		t.Fatalf("expected request limit error, got %v", err)
	}
}

// B8：脚本持续分配内存时被中断，且不执行写值。
func TestRunInterruptsOnMemoryLimit(t *testing.T) {
	code := `Write("a", 1); var keep = []; for (;;) { keep.push(new Array(1000).fill("xxxxxxxxxxxxxxxx" + keep.length)); }`
	response := runRequest(t, Request{Code: code, Tags: map[string]string{"a": "tag-a"}})
	if response.OK || response.Error != memoryLimitMessage {
		t.Fatalf("expected memory limit error, got %+v", response)
	}
	if len(response.Writes) != 0 {
		t.Fatalf("writes from an over-limit script must be dropped: %+v", response.Writes)
	}
}

func TestRunNormalScriptUnaffectedByMemoryWatch(t *testing.T) {
	response := runRequest(t, Request{Code: `var a = []; for (var i = 0; i < 10000; i++) a.push(i); Write("a", a.length)`, Tags: map[string]string{"a": "tag-a"}})
	if !response.OK || len(response.Writes) != 1 {
		t.Fatalf("unexpected response: %+v", response)
	}
}
