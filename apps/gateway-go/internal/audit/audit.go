package audit

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"
)

type Event struct {
	At     time.Time      `json:"at"`
	Actor  string         `json:"actor"`
	Action string         `json:"action"`
	Target string         `json:"target"`
	Detail map[string]any `json:"detail,omitempty"`
}

type Logger struct {
	mu   sync.Mutex
	path string
}

func New(path string) *Logger { return &Logger{path: path} }

func (l *Logger) Record(event Event) error {
	if l == nil || l.path == "" {
		return nil
	}
	if event.At.IsZero() {
		event.At = time.Now().UTC()
	}
	b, err := json.Marshal(event)
	if err != nil {
		return fmt.Errorf("encode audit event: %w", err)
	}

	l.mu.Lock()
	defer l.mu.Unlock()
	if err := os.MkdirAll(filepath.Dir(l.path), 0o750); err != nil {
		return fmt.Errorf("create audit directory: %w", err)
	}
	f, err := os.OpenFile(l.path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o640)
	if err != nil {
		return fmt.Errorf("open audit log: %w", err)
	}
	defer f.Close()
	if _, err := f.Write(append(b, '\n')); err != nil {
		return fmt.Errorf("write audit event: %w", err)
	}
	return nil
}

// Recent 返回最新的 limit 条事件（新的在前）。审计文件在 G3 迁入 SQLite 前为 JSONL，
// 这里整文件读取；损坏行跳过。
func (l *Logger) Recent(limit int) ([]Event, error) {
	if l == nil || l.path == "" {
		return []Event{}, nil
	}
	l.mu.Lock()
	data, err := os.ReadFile(l.path)
	l.mu.Unlock()
	if os.IsNotExist(err) {
		return []Event{}, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read audit log: %w", err)
	}
	lines := bytes.Split(data, []byte{'\n'})
	events := make([]Event, 0, limit)
	for i := len(lines) - 1; i >= 0 && len(events) < limit; i-- {
		if len(bytes.TrimSpace(lines[i])) == 0 {
			continue
		}
		var event Event
		if json.Unmarshal(lines[i], &event) == nil {
			events = append(events, event)
		}
	}
	return events, nil
}
