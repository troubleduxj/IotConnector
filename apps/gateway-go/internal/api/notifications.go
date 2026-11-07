package api

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"crypto/tls"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"github.com/factorybridge/iotconnector/gateway-go/internal/config"
	"net"
	"net/http"
	"net/smtp"
	"net/url"
	"strings"
	"time"
)

func (s *Server) notifications(w http.ResponseWriter, r *http.Request) {
	if !s.authorize(w, r, RoleViewer) {
		return
	}
	writeJSON(w, http.StatusOK, redactSecrets(s.notificationConfig()))
}

func (s *Server) updateNotifications(w http.ResponseWriter, r *http.Request) {
	if !s.authorize(w, r, RoleAdmin) {
		return
	}
	var patch map[string]any
	if err := json.NewDecoder(r.Body).Decode(&patch); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": "invalid notification JSON"})
		return
	}
	preserveSecrets(patch)
	s.configMu.Lock()
	current := s.notificationConfig()
	mergeMap(current, patch)
	err := s.commitRawLocked("notifications", current)
	s.configMu.Unlock()
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, redactSecrets(current))
}

func (s *Server) testNotification(w http.ResponseWriter, r *http.Request) {
	if !s.authorize(w, r, RoleAdmin) {
		return
	}
	var request struct {
		Channel string `json:"channel"`
	}
	_ = json.NewDecoder(r.Body).Decode(&request)
	if request.Channel == "" {
		request.Channel = "webhook"
	}
	cfg := s.notificationConfig()
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	err := sendConfiguredNotification(ctx, cfg, request.Channel, alarmEvent{State: "Test", Message: "FactoryBridge notification test", TS: time.Now().UnixMilli()})
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "channel": request.Channel})
}

func (s *Server) notificationConfig() map[string]any {
	if value, ok := s.cfg().Raw["notifications"].(map[string]any); ok {
		return config.DeepCopyMap(value)
	}
	return map[string]any{"enabled": false, "webhookUrl": "", "dingtalk": map[string]any{"enabled": false, "webhookUrl": "", "secret": ""}, "wecom": map[string]any{"enabled": false, "webhookUrl": ""}, "email": map[string]any{"enabled": false}}
}

func mergeMap(target, patch map[string]any) {
	for key, value := range patch {
		if nested, ok := value.(map[string]any); ok {
			base, _ := target[key].(map[string]any)
			if base == nil {
				base = map[string]any{}
			}
			mergeMap(base, nested)
			target[key] = base
		} else {
			target[key] = value
		}
	}
}

func postNotification(ctx context.Context, url string, body any) error {
	payload, _ := json.Marshal(body)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(payload))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	response, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return fmt.Errorf("notification HTTP %d", response.StatusCode)
	}
	return nil
}

func (s *Server) dispatchNotification(event alarmEvent) {
	if event.State != "Active" {
		return
	}
	cfg := s.notificationConfig()
	enabled, _ := cfg["enabled"].(bool)
	if !enabled {
		return
	}
	channels := []string{"webhook", "dingtalk", "wecom", "email"}
	for _, channel := range channels {
		channel := channel
		go func() {
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			if err := sendConfiguredNotification(ctx, cfg, channel, event); err != nil {
				fmt.Printf("notification delivery failed channel=%s: %v\n", channel, err)
			}
		}()
	}
}

func sendConfiguredNotification(ctx context.Context, cfg map[string]any, channel string, event alarmEvent) error {
	message := map[string]any{"event": event.State, "tagName": event.TagName, "channel": event.Channel, "kind": event.Kind, "value": event.Value, "threshold": event.Threshold, "ts": event.TS, "message": event.Message}
	switch channel {
	case "webhook":
		endpoint := strings.TrimSpace(stringValue(cfg["webhookUrl"]))
		if endpoint == "" {
			return fmt.Errorf("Webhook URL is not configured")
		}
		return postNotification(ctx, endpoint, message)
	case "dingtalk":
		nested, _ := cfg["dingtalk"].(map[string]any)
		endpoint := strings.TrimSpace(stringValue(nested["webhookUrl"]))
		if endpoint == "" {
			return fmt.Errorf("DingTalk URL is not configured")
		}
		if secret := stringValue(nested["secret"]); secret != "" {
			ts := time.Now().UnixMilli()
			mac := hmac.New(sha256.New, []byte(secret))
			_, _ = mac.Write([]byte(fmt.Sprintf("%d\n%s", ts, secret)))
			query := url.Values{}
			query.Set("timestamp", fmt.Sprint(ts))
			query.Set("sign", base64.StdEncoding.EncodeToString(mac.Sum(nil)))
			endpoint += "&" + query.Encode()
		}
		return postNotification(ctx, endpoint, map[string]any{"msgtype": "text", "text": map[string]any{"content": event.Message}})
	case "wecom":
		nested, _ := cfg["wecom"].(map[string]any)
		endpoint := strings.TrimSpace(stringValue(nested["webhookUrl"]))
		if endpoint == "" {
			return fmt.Errorf("WeCom URL is not configured")
		}
		return postNotification(ctx, endpoint, map[string]any{"msgtype": "text", "text": map[string]any{"content": event.Message}})
	case "email":
		nested, _ := cfg["email"].(map[string]any)
		return sendSMTP(ctx, nested, event.Message)
	default:
		return fmt.Errorf("unsupported notification channel: %s", channel)
	}
}

func sendSMTP(ctx context.Context, cfg map[string]any, body string) error {
	host := stringValue(cfg["host"])
	to := stringValue(cfg["to"])
	if host == "" || to == "" {
		return fmt.Errorf("SMTP host/to is not configured")
	}
	port := int(stringNumber(cfg["port"]))
	if port == 0 {
		port = 465
	}
	username, password := stringValue(cfg["username"]), stringValue(cfg["password"])
	from := username
	if from == "" {
		from = to
	}
	address := net.JoinHostPort(host, fmt.Sprint(port))
	message := []byte("From: " + from + "\r\nTo: " + to + "\r\nSubject: FactoryBridge alert\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n" + body + "\r\n")
	dialer := net.Dialer{Timeout: 5 * time.Second}
	var client *smtp.Client
	var conn net.Conn
	var err error
	secure, _ := cfg["secure"].(bool)
	if secure {
		conn, err = tls.DialWithDialer(&dialer, "tcp", address, &tls.Config{ServerName: host, MinVersion: tls.VersionTLS12})
		if err == nil {
			client, err = smtp.NewClient(conn, host)
		}
	} else {
		conn, err = dialer.DialContext(ctx, "tcp", address)
		if err == nil {
			client, err = smtp.NewClient(conn, host)
		}
	}
	if err != nil {
		return err
	}
	defer client.Close()
	if username != "" {
		if hasStartTLS, _ := client.Extension("STARTTLS"); hasStartTLS && !secure {
			if err := client.StartTLS(&tls.Config{ServerName: host, MinVersion: tls.VersionTLS12}); err != nil {
				return err
			}
		}
		if err := client.Auth(smtp.PlainAuth("", username, password, host)); err != nil {
			return err
		}
	}
	if err := client.Mail(from); err != nil {
		return err
	}
	if err := client.Rcpt(to); err != nil {
		return err
	}
	writer, err := client.Data()
	if err != nil {
		return err
	}
	if _, err = writer.Write(message); err != nil {
		_ = writer.Close()
		return err
	}
	return writer.Close()
}

func stringNumber(value any) float64 {
	switch v := value.(type) {
	case float64:
		return v
	case int:
		return float64(v)
	case json.Number:
		n, _ := v.Float64()
		return n
	default:
		return 0
	}
}
