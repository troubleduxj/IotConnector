package audit

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/factorybridge/iotconnector/gateway-go/internal/db"
)

type Event struct {
	At     time.Time      `json:"at"`
	Actor  string         `json:"actor"`
	Action string         `json:"action"`
	Target string         `json:"target"`
	Detail map[string]any `json:"detail,omitempty"`
}

// Logger 写审计事件。配置了 SQLite 时写 audit_events 表（G3），否则写 JSONL 文件（测试与旧调用方）。
//
// 审计事件写入不走 db.Batch：审计要求事件在返回前已落盘，量也远小于采样。
type Logger struct {
	mu   sync.Mutex
	path string
	db   *db.DB
}

// Retention 是审计事件保留期，Prune 删除更早的事件。
const Retention = 365 * 24 * time.Hour

func New(path string) *Logger { return &Logger{path: path} }

// NewDB 返回写入 SQLite 的 Logger；legacyPath 是旧 audit.jsonl，库为空时导入一次并改名为 .migrated。
func NewDB(database *db.DB, legacyPath string) *Logger {
	l := &Logger{db: database}
	l.importLegacy(legacyPath)
	return l
}

func (l *Logger) Record(event Event) error {
	if l == nil {
		return nil
	}
	if event.At.IsZero() {
		event.At = time.Now().UTC()
	}
	if l.db != nil {
		detail, err := json.Marshal(event.Detail)
		if err != nil {
			return fmt.Errorf("encode audit detail: %w", err)
		}
		_, err = l.db.Exec(`INSERT INTO audit_events(at, actor, action, target, detail) VALUES (?, ?, ?, ?, ?)`,
			event.At.UnixMilli(), event.Actor, event.Action, event.Target, string(detail))
		return err
	}
	if l.path == "" {
		return nil
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

// Recent 返回最新的 limit 条事件（新的在前）。
func (l *Logger) Recent(limit int) ([]Event, error) {
	if l == nil {
		return []Event{}, nil
	}
	if l.db != nil {
		rows, err := l.db.Query(`SELECT at, actor, action, target, detail FROM audit_events ORDER BY id DESC LIMIT ?`, limit)
		if err != nil {
			return nil, err
		}
		defer rows.Close()
		events := make([]Event, 0, limit)
		for rows.Next() {
			var at int64
			var detail string
			var event Event
			if err := rows.Scan(&at, &event.Actor, &event.Action, &event.Target, &detail); err != nil {
				return nil, err
			}
			event.At = time.UnixMilli(at).UTC()
			_ = json.Unmarshal([]byte(detail), &event.Detail)
			events = append(events, event)
		}
		return events, rows.Err()
	}
	if l.path == "" {
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
	return parseRecent(data, limit), nil
}

func parseRecent(data []byte, limit int) []Event {
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
	return events
}

// Prune 删除超出保留期的审计事件。
func (l *Logger) Prune(ctx context.Context) error {
	if l == nil || l.db == nil {
		return nil
	}
	_, err := l.db.ExecContext(ctx, `DELETE FROM audit_events WHERE at < ?`, time.Now().Add(-Retention).UnixMilli())
	return err
}

func (l *Logger) importLegacy(path string) {
	if path == "" || l.db == nil {
		return
	}
	var existing int
	if l.db.QueryRow(`SELECT COUNT(*) FROM audit_events`).Scan(&existing) != nil || existing > 0 {
		return
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return
	}
	tx, err := l.db.Begin()
	if err != nil {
		return
	}
	stmt, err := tx.Prepare(`INSERT INTO audit_events(at, actor, action, target, detail) VALUES (?, ?, ?, ?, ?)`)
	if err != nil {
		_ = tx.Rollback()
		return
	}
	for _, line := range bytes.Split(data, []byte{'\n'}) {
		event, ok := parseLegacyLine(line)
		if !ok {
			continue // 跳过空行与损坏行
		}
		detail, _ := json.Marshal(event.Detail)
		if _, err := stmt.Exec(event.At.UnixMilli(), event.Actor, event.Action, event.Target, string(detail)); err != nil {
			_ = stmt.Close()
			_ = tx.Rollback()
			return
		}
	}
	_ = stmt.Close()
	if tx.Commit() == nil {
		_ = os.Rename(path, path+".migrated")
	}
}

// parseLegacyLine 解析 audit.jsonl 的一行。文件里混有两种格式：
//   - Go 网关：{"at":"RFC3339","actor":…,"action":…,"target":…,"detail":{…}}
//   - Node 网关：{"ts":毫秒,"user":…,"role":…,"action":…,"detail":"文本"}
//
// 两个网关共用过同一数据目录，实测 1391 行中 1317 行是 Node 格式。
func parseLegacyLine(line []byte) (Event, bool) {
	if len(bytes.TrimSpace(line)) == 0 {
		return Event{}, false
	}
	var raw struct {
		At     time.Time       `json:"at"`
		Actor  string          `json:"actor"`
		Target string          `json:"target"`
		TS     int64           `json:"ts"`
		User   string          `json:"user"`
		Role   string          `json:"role"`
		Action string          `json:"action"`
		Detail json.RawMessage `json:"detail"`
	}
	if json.Unmarshal(line, &raw) != nil || raw.Action == "" {
		return Event{}, false
	}
	fromNode := raw.At.IsZero() && raw.TS > 0
	event := Event{At: raw.At, Actor: raw.Actor, Action: raw.Action, Target: raw.Target}
	if fromNode {
		event.At = time.UnixMilli(raw.TS).UTC()
		event.Actor = raw.User
	}
	if event.At.IsZero() {
		return Event{}, false
	}
	if len(raw.Detail) > 0 {
		var structured map[string]any
		var text string
		switch {
		case json.Unmarshal(raw.Detail, &structured) == nil:
			event.Detail = structured
		case json.Unmarshal(raw.Detail, &text) == nil && text != "":
			event.Detail = map[string]any{"text": text}
		}
	}
	if fromNode {
		if event.Detail == nil {
			event.Detail = map[string]any{}
		}
		event.Detail["source"] = "node"
		if raw.Role != "" {
			event.Detail["role"] = raw.Role
		}
	}
	return event, true
}
