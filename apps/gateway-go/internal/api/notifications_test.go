package api

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

func TestWebhookNotificationPostsAlarmJSON(t *testing.T) {
	var payload map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.Header.Get("Content-Type") != "application/json" {
			t.Errorf("unexpected request: %s %s content-type=%q", r.Method, r.URL, r.Header.Get("Content-Type"))
		}
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			t.Errorf("decode payload: %v", err)
		}
		w.WriteHeader(http.StatusAccepted)
	}))
	defer server.Close()

	err := sendConfiguredNotification(context.Background(), map[string]any{"webhookUrl": server.URL}, "webhook", alarmEvent{State: "Active", TagName: "T1", Value: 42, Message: "high"})
	if err != nil {
		t.Fatal(err)
	}
	if payload["event"] != "Active" || payload["tagName"] != "T1" || payload["value"] != float64(42) {
		t.Fatalf("unexpected webhook payload: %#v", payload)
	}
}

func TestDingTalkNotificationSignsRequest(t *testing.T) {
	const secret = "test-secret"
	var received string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		received = r.URL.RawQuery
		var payload map[string]any
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			t.Errorf("decode payload: %v", err)
		}
		if payload["msgtype"] != "text" {
			t.Errorf("unexpected DingTalk payload: %#v", payload)
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	if err := sendConfiguredNotification(context.Background(), map[string]any{
		"dingtalk": map[string]any{"webhookUrl": server.URL + "?access_token=x", "secret": secret},
	}, "dingtalk", alarmEvent{Message: "alarm"}); err != nil {
		t.Fatal(err)
	}
	values, err := url.ParseQuery(received)
	if err != nil {
		t.Fatal(err)
	}
	timestamp, sign := values.Get("timestamp"), values.Get("sign")
	if timestamp == "" || sign == "" {
		t.Fatalf("missing DingTalk signature: %q", received)
	}
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write([]byte(timestamp + "\n" + secret))
	expected := base64.StdEncoding.EncodeToString(mac.Sum(nil))
	if sign != expected {
		t.Fatalf("unexpected DingTalk signature: got %q want %q", sign, expected)
	}
}

func TestWeComNotificationPostsTextMessage(t *testing.T) {
	var body string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		data, _ := io.ReadAll(r.Body)
		body = string(data)
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	if err := sendConfiguredNotification(context.Background(), map[string]any{
		"wecom": map[string]any{"webhookUrl": server.URL},
	}, "wecom", alarmEvent{Message: "设备告警"}); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(body, `"msgtype":"text"`) || !strings.Contains(body, "设备告警") {
		t.Fatalf("unexpected WeCom payload: %s", body)
	}
}
