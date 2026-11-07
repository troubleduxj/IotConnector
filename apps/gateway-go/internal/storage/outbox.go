package storage

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
)

// loadQueue 从 SQLite 恢复队列；库中为空时导入旧 JSON 队列文件（outbox.json、
// 分段文件 outbox.json.part-*、alarm-outbox.json），落盘成功后原文件改名为 .migrated。
func (w *Writer) loadQueue() {
	if w.cfg.StateDB == nil {
		return
	}
	ctx := context.Background()
	rows, err := w.cfg.StateDB.QueryContext(ctx, `SELECT id, tag_id, tag_name, channel, data_type, value, ts FROM outbox_points ORDER BY id`)
	if err == nil {
		for rows.Next() {
			var p point
			if rows.Scan(&p.id, &p.TagID, &p.TagName, &p.Channel, &p.DataType, &p.Value, &p.Timestamp) == nil {
				w.queue = append(w.queue, p)
			}
		}
		rows.Close()
	}
	alarmRows, err := w.cfg.StateDB.QueryContext(ctx, `SELECT id, payload FROM outbox_alarms ORDER BY id`)
	if err == nil {
		for alarmRows.Next() {
			var item queuedAlarm
			var payload string
			if alarmRows.Scan(&item.id, &payload) == nil && json.Unmarshal([]byte(payload), &item.event) == nil {
				w.alarmQueue = append(w.alarmQueue, item)
			}
		}
		alarmRows.Close()
	}
	w.nextPoint, _ = w.cfg.StateDB.NextID(ctx, "outbox_points")
	w.nextAlarm, _ = w.cfg.StateDB.NextID(ctx, "outbox_alarms")
	if len(w.queue) == 0 {
		w.importLegacyPoints(ctx)
	}
	if len(w.alarmQueue) == 0 {
		w.importLegacyAlarms(ctx)
	}
}

func (w *Writer) importLegacyPoints(ctx context.Context) {
	if w.cfg.QueueFile == "" {
		return
	}
	files, _ := filepath.Glob(w.cfg.QueueFile + ".part-*")
	sort.Strings(files)
	if _, err := os.Stat(w.cfg.QueueFile); err == nil {
		files = append([]string{w.cfg.QueueFile}, files...)
	}
	if len(files) == 0 {
		return
	}
	for _, file := range files {
		b, err := os.ReadFile(file)
		if err != nil {
			continue
		}
		var values []point
		if json.Unmarshal(b, &values) != nil {
			continue
		}
		for _, p := range values {
			w.nextPoint++
			p.id = w.nextPoint
			w.queue = append(w.queue, p)
			w.cfg.State.Exec(`INSERT INTO outbox_points(id, tag_id, tag_name, channel, data_type, value, ts) VALUES (?, ?, ?, ?, ?, ?, ?)`,
				p.id, p.TagID, p.TagName, p.Channel, p.DataType, p.Value, p.Timestamp)
		}
	}
	if over := len(w.queue) - w.cfg.MaxQueue; over > 0 {
		w.queue = w.queue[over:]
		w.cfg.State.Exec(`DELETE FROM outbox_points WHERE id < ?`, w.queue[0].id)
	}
	// 必须先确认落盘再改名原文件；失败时保留原文件，下次启动重试
	if err := w.cfg.State.Flush(ctx); err != nil {
		return
	}
	for _, file := range files {
		_ = os.Rename(file, file+".migrated")
	}
}

func (w *Writer) importLegacyAlarms(ctx context.Context) {
	if w.cfg.AlarmQueueFile == "" {
		return
	}
	b, err := os.ReadFile(w.cfg.AlarmQueueFile)
	if err != nil {
		return
	}
	var events []AlarmEvent
	if json.Unmarshal(b, &events) != nil {
		return
	}
	for _, event := range events {
		payload, err := json.Marshal(event)
		if err != nil {
			continue
		}
		w.nextAlarm++
		w.alarmQueue = append(w.alarmQueue, queuedAlarm{id: w.nextAlarm, event: event})
		w.cfg.State.Exec(`INSERT INTO outbox_alarms(id, payload) VALUES (?, ?)`, w.nextAlarm, string(payload))
	}
	if w.cfg.State.Flush(ctx) == nil {
		_ = os.Rename(w.cfg.AlarmQueueFile, w.cfg.AlarmQueueFile+".migrated")
	}
}
