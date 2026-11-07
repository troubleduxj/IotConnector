package storage

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/factorybridge/iotconnector/gateway-go/internal/acquisition"
)

type Config struct {
	URL            string
	User           string
	Password       string
	Database       string
	SuperTable     string
	QueueFile      string
	AlarmQueueFile string
	MaxQueue       int
	SegmentSize    int
}

type Status struct {
	Engine  string `json:"engine"`
	State   string `json:"state"`
	Queued  int    `json:"queued"`
	Written int    `json:"written"`
	Dropped int    `json:"dropped"`
	Error   string `json:"error,omitempty"`
}

type QueryTag struct {
	ID   string
	Name string
}

type HistoryPoint struct {
	TS    int64
	Value float64
}

type AlarmEvent struct {
	ID        string
	RuleID    string
	TagID     string
	TagName   string
	Channel   string
	State     string
	Kind      string
	Threshold float64
	Value     float64
	Timestamp int64
	Message   string
}

type point struct {
	TagID     string  `json:"tagId"`
	TagName   string  `json:"tagName"`
	Channel   string  `json:"channel"`
	DataType  string  `json:"dataType"`
	Value     float64 `json:"value"`
	Timestamp int64   `json:"ts"`
}

type Writer struct {
	mu         sync.Mutex
	cfg        Config
	queue      []point
	alarmQueue []AlarmEvent
	status     Status
	client     *http.Client
}

// Keep recovery writes below TDengine/taosAdapter SQL size limits. The queue
// itself remains durable; only the in-flight statement is bounded.
const maxInsertPoints = 500

func New(cfg Config) *Writer {
	if cfg.MaxQueue <= 0 {
		cfg.MaxQueue = 100000
	}
	if cfg.SegmentSize <= 0 {
		cfg.SegmentSize = 10000
	}
	w := &Writer{cfg: cfg, client: &http.Client{Timeout: 10 * time.Second}}
	w.status = Status{Engine: "tdengine", State: "disabled"}
	if cfg.URL != "" {
		w.status.State = "offline"
	}
	w.loadQueue()
	return w
}

func (w *Writer) Status() Status {
	w.mu.Lock()
	defer w.mu.Unlock()
	s := w.status
	s.Queued = len(w.queue) + len(w.alarmQueue)
	return s
}

func (w *Writer) Enabled() bool { return w.cfg.URL != "" }

func (w *Writer) ConfigSummary() (string, string) { return w.cfg.URL, w.cfg.Database }

func (w *Writer) Ping(ctx context.Context) error {
	if !w.Enabled() {
		return fmt.Errorf("TDENGINE_URL is not configured")
	}
	return w.query(ctx, "SELECT 1")
}

func (w *Writer) Init(ctx context.Context) error {
	if !w.Enabled() {
		return fmt.Errorf("TDENGINE_URL is not configured")
	}
	return w.ensureSchema(ctx)
}

func (w *Writer) Execute(ctx context.Context, sql string) error {
	if !w.Enabled() {
		return fmt.Errorf("TDENGINE_URL is not configured")
	}
	return w.query(ctx, sql)
}

func (w *Writer) WriteAlarmEvent(ctx context.Context, event AlarmEvent) error {
	if !w.Enabled() {
		return fmt.Errorf("TDENGINE_URL is not configured")
	}
	db := safeIdentifier(w.cfg.Database)
	// Keep the alarm table compatible with the Node gateway schema. The shared
	// table uses status/val and conservative VARCHAR widths across both writers.
	create := fmt.Sprintf("CREATE TABLE IF NOT EXISTS %s.alarm_events (ts TIMESTAMP, event_id VARCHAR(64), rule_id VARCHAR(64), tag_id VARCHAR(32), tag_name VARCHAR(128), channel VARCHAR(64), status VARCHAR(8), kind VARCHAR(8), threshold DOUBLE, val DOUBLE, message VARCHAR(200))", db)
	if err := w.query(ctx, create); err != nil {
		return err
	}
	insert := fmt.Sprintf("INSERT INTO %s.alarm_events VALUES (%d,'%s','%s','%s','%s','%s','%s','%s',%f,%f,'%s')", db, event.Timestamp, escN(event.ID, 64), escN(event.RuleID, 64), escN(event.TagID, 32), escN(event.TagName, 128), escN(event.Channel, 64), escN(event.State, 8), escN(event.Kind, 8), event.Threshold, event.Value, escN(event.Message, 200))
	return w.query(ctx, insert)
}

func (w *Writer) EnqueueAlarmEvent(event AlarmEvent) {
	if !w.Enabled() {
		return
	}
	w.mu.Lock()
	if len(w.alarmQueue) >= w.cfg.MaxQueue {
		w.alarmQueue = w.alarmQueue[1:]
		w.status.Dropped++
		w.status.Error = "alarm outbox overflow"
	}
	w.alarmQueue = append(w.alarmQueue, event)
	w.persistAlarmQueueLocked()
	w.mu.Unlock()
}

func (w *Writer) QueryHistory(ctx context.Context, tags []QueryTag, start, end int64) (map[string][]HistoryPoint, error) {
	result := make(map[string][]HistoryPoint, len(tags))
	if !w.Enabled() {
		return result, fmt.Errorf("TDENGINE_URL is not configured")
	}
	for _, tag := range tags {
		if tag.ID == "" || tag.Name == "" {
			continue
		}
		where := ""
		if start > 0 {
			where = fmt.Sprintf(" WHERE ts >= %d", start)
		}
		if end > 0 {
			if where == "" {
				where = " WHERE "
			} else {
				where += " AND "
			}
			where += fmt.Sprintf("ts <= %d", end)
		}
		sql := fmt.Sprintf("SELECT ts,val FROM %s.%s%s ORDER BY ts", safeIdentifier(w.cfg.Database), "tb_"+hashName(tag.Name), where)
		rows, err := w.queryRows(ctx, sql)
		if err != nil {
			return nil, err
		}
		for _, row := range rows {
			if len(row) < 2 {
				continue
			}
			ts, okTS := numberInt64(row[0])
			value, okValue := numberFloat64(row[1])
			if okTS && okValue {
				result[tag.ID] = append(result[tag.ID], HistoryPoint{TS: ts, Value: value})
			}
		}
	}
	return result, nil
}

func (w *Writer) Enqueue(tag acquisition.Tag, sample acquisition.Sample) {
	if w.cfg.URL == "" {
		return
	}
	if sample.Value.Number == nil && sample.Value.Bool == nil {
		return
	}
	value := 0.0
	if sample.Value.Number != nil {
		value = *sample.Value.Number
		if math.IsNaN(value) || math.IsInf(value, 0) {
			return
		}
	} else if *sample.Value.Bool {
		value = 1
	}
	w.mu.Lock()
	if len(w.queue) >= w.cfg.MaxQueue {
		w.queue = w.queue[1:]
		w.status.Dropped++
		w.status.Error = "outbox overflow"
	}
	w.queue = append(w.queue, point{TagID: tag.ID, TagName: tag.Name, Channel: tag.ChannelID, DataType: tag.DataType, Value: value, Timestamp: sample.SampledAt})
	w.persistQueueLocked()
	w.mu.Unlock()
}

func (w *Writer) Flush(ctx context.Context) error {
	if w.cfg.URL == "" {
		return nil
	}
	w.mu.Lock()
	if len(w.queue) == 0 && len(w.alarmQueue) == 0 {
		w.mu.Unlock()
		return nil
	}
	batchSize := len(w.queue)
	if batchSize > maxInsertPoints {
		batchSize = maxInsertPoints
	}
	batch := append([]point(nil), w.queue[:batchSize]...)
	alarmBatch := append([]AlarmEvent(nil), w.alarmQueue...)
	w.mu.Unlock()
	for _, event := range alarmBatch {
		if err := w.WriteAlarmEvent(ctx, event); err != nil {
			w.setError(err)
			return err
		}
	}
	if err := w.ensureSchema(ctx); err != nil {
		w.setError(err)
		return err
	}
	parts := make([]string, 0, len(batch))
	for _, p := range batch {
		child := "tb_" + hashName(p.TagName)
		parts = append(parts, fmt.Sprintf("%s.%s USING %s.%s TAGS('%s','%s','%s') VALUES (%d,%f)", w.cfg.Database, child, w.cfg.Database, w.cfg.SuperTable, escN(p.Channel, 64), escN(p.TagName, 128), escN(p.DataType, 16), p.Timestamp, p.Value))
	}
	sql := "INSERT INTO " + strings.Join(parts, " ")
	if err := w.query(ctx, sql); err != nil {
		w.setError(err)
		return err
	}
	w.mu.Lock()
	if len(w.alarmQueue) >= len(alarmBatch) {
		w.alarmQueue = w.alarmQueue[len(alarmBatch):]
	} else {
		w.alarmQueue = nil
	}
	if len(w.queue) >= len(batch) {
		w.queue = w.queue[len(batch):]
	} else {
		w.queue = nil
	}
	w.status.State, w.status.Error = "online", ""
	w.status.Written += len(batch)
	w.persistQueueLocked()
	w.persistAlarmQueueLocked()
	w.mu.Unlock()
	return nil
}

func (w *Writer) ensureSchema(ctx context.Context) error {
	if err := w.query(ctx, fmt.Sprintf("CREATE DATABASE IF NOT EXISTS %s", w.cfg.Database)); err != nil {
		return err
	}
	sql := fmt.Sprintf("CREATE STABLE IF NOT EXISTS %s.%s (ts TIMESTAMP, val DOUBLE) TAGS (channel VARCHAR(64), tag_name VARCHAR(128), data_type VARCHAR(16))", safeIdentifier(w.cfg.Database), safeIdentifier(w.cfg.SuperTable))
	return w.query(ctx, sql)
}

func (w *Writer) query(ctx context.Context, sql string) error {
	_, err := w.queryResponse(ctx, sql)
	return err
}

func (w *Writer) queryRows(ctx context.Context, sql string) ([][]any, error) {
	response, err := w.queryResponse(ctx, sql)
	if err != nil {
		return nil, err
	}
	var payload struct {
		Data [][]any `json:"data"`
	}
	if err := json.Unmarshal(response, &payload); err != nil {
		return nil, err
	}
	return payload.Data, nil
}

func (w *Writer) queryResponse(ctx context.Context, sql string) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(w.cfg.URL, "/")+"/rest/sql", bytes.NewBufferString(sql))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "text/plain")
	req.Header.Set("Authorization", "Basic "+base64.StdEncoding.EncodeToString([]byte(w.cfg.User+":"+w.cfg.Password)))
	response, err := w.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	body, readErr := io.ReadAll(response.Body)
	if readErr != nil {
		return nil, readErr
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return nil, fmt.Errorf("tdengine HTTP %d", response.StatusCode)
	}
	var result struct {
		Code int    `json:"code"`
		Msg  string `json:"msg"`
		Desc string `json:"desc"`
	}
	if err := json.Unmarshal(body, &result); err != nil {
		return nil, err
	}
	if result.Code != 0 {
		detail := result.Msg
		if detail == "" {
			detail = result.Desc
		}
		return nil, fmt.Errorf("tdengine %d: %s", result.Code, detail)
	}
	return body, nil
}

func (w *Writer) setError(err error) {
	w.mu.Lock()
	w.status.State = "offline"
	w.status.Error = err.Error()
	w.mu.Unlock()
}

func (w *Writer) loadQueue() {
	if w.cfg.QueueFile == "" {
		return
	}
	parts, _ := filepath.Glob(w.cfg.QueueFile + ".part-*")
	sort.Strings(parts)
	if len(parts) > 0 {
		for _, part := range parts {
			if b, err := os.ReadFile(part); err == nil {
				var values []point
				if json.Unmarshal(b, &values) == nil {
					w.queue = append(w.queue, values...)
				}
			}
		}
	} else if b, err := os.ReadFile(w.cfg.QueueFile); err == nil {
		_ = json.Unmarshal(b, &w.queue)
	}
	if w.cfg.AlarmQueueFile != "" {
		if alarmBytes, alarmErr := os.ReadFile(w.cfg.AlarmQueueFile); alarmErr == nil {
			_ = json.Unmarshal(alarmBytes, &w.alarmQueue)
		}
	}
}

func (w *Writer) persistAlarmQueueLocked() {
	if w.cfg.AlarmQueueFile == "" {
		return
	}
	if err := os.MkdirAll(filepath.Dir(w.cfg.AlarmQueueFile), 0o750); err != nil {
		return
	}
	b, err := json.Marshal(w.alarmQueue)
	if err != nil {
		return
	}
	tmp, err := os.CreateTemp(filepath.Dir(w.cfg.AlarmQueueFile), ".alarm-outbox-*.json")
	if err != nil {
		return
	}
	name := tmp.Name()
	defer os.Remove(name)
	_, _ = tmp.Write(b)
	_ = tmp.Sync()
	_ = tmp.Close()
	_ = os.Rename(name, w.cfg.AlarmQueueFile)
}

func (w *Writer) persistQueueLocked() {
	if w.cfg.QueueFile == "" {
		return
	}
	if err := os.MkdirAll(filepath.Dir(w.cfg.QueueFile), 0o750); err != nil {
		return
	}
	oldParts, _ := filepath.Glob(w.cfg.QueueFile + ".part-*")
	for _, part := range oldParts {
		_ = os.Remove(part)
	}
	if len(w.queue) > w.cfg.SegmentSize {
		for start, index := 0, 0; start < len(w.queue); start, index = start+w.cfg.SegmentSize, index+1 {
			end := start + w.cfg.SegmentSize
			if end > len(w.queue) {
				end = len(w.queue)
			}
			if err := atomicJSONWrite(fmt.Sprintf("%s.part-%06d", w.cfg.QueueFile, index), w.queue[start:end]); err != nil {
				return
			}
		}
		_ = atomicJSONWrite(w.cfg.QueueFile, []point{})
		return
	}
	_ = atomicJSONWrite(w.cfg.QueueFile, w.queue)
}

func atomicJSONWrite(path string, value any) error {
	b, err := json.Marshal(value)
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), ".outbox-write-*.json")
	if err != nil {
		return err
	}
	name := tmp.Name()
	defer os.Remove(name)
	if _, err = tmp.Write(b); err != nil {
		_ = tmp.Close()
		return err
	}
	if err = tmp.Sync(); err != nil {
		_ = tmp.Close()
		return err
	}
	if err = tmp.Close(); err != nil {
		return err
	}
	return os.Rename(name, path)
}

// esc 把值转成可放进 TDengine 单引号字符串字面量的形式。
// 先转义反斜杠，再转义单引号；原实现顺序相反，会把 \' 中的反斜杠替换掉，留下裸引号。
// 控制字符替换为空格，避免换行等字符破坏 SQL。
func esc(value string) string {
	var b strings.Builder
	b.Grow(len(value))
	for _, r := range value {
		switch {
		case r == '\\':
			b.WriteString(`\\`)
		case r == '\'':
			b.WriteString(`\'`)
		case r < 0x20 || r == 0x7f:
			b.WriteByte(' ')
		default:
			b.WriteRune(r)
		}
	}
	return b.String()
}

// escN 先按列宽截断再转义。TDengine 对超长 VARCHAR 直接报错，
// 一条超长记录会让整批写入失败并卡在队首反复重试，所以写入前按字节截断（不切开 UTF-8 字符）。
func escN(value string, maxBytes int) string {
	if len(value) > maxBytes {
		cut := maxBytes
		for cut > 0 && !utf8.RuneStart(value[cut]) {
			cut--
		}
		value = value[:cut]
	}
	return esc(value)
}

func hashName(value string) string {
	var hash uint32 = 2166136261
	for _, char := range value {
		hash ^= uint32(char)
		hash *= 16777619
	}
	return fmt.Sprintf("%08x", hash)
}

func safeIdentifier(value string) string {
	var b strings.Builder
	for _, char := range value {
		if (char >= 'a' && char <= 'z') || (char >= 'A' && char <= 'Z') || (char >= '0' && char <= '9') || char == '_' {
			b.WriteRune(char)
		}
	}
	if b.Len() == 0 {
		return "factory_bridge"
	}
	return b.String()
}

func numberFloat64(value any) (float64, bool) {
	switch v := value.(type) {
	case float64:
		return v, true
	case json.Number:
		n, err := v.Float64()
		return n, err == nil
	default:
		return 0, false
	}
}

func numberInt64(value any) (int64, bool) {
	if text, ok := value.(string); ok {
		if timestamp, err := time.Parse(time.RFC3339Nano, text); err == nil {
			return timestamp.UnixMilli(), true
		}
		if timestamp, err := strconv.ParseInt(text, 10, 64); err == nil {
			return timestamp, true
		}
	}
	n, ok := numberFloat64(value)
	return int64(n), ok
}
