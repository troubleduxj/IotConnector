package api

import (
	"bufio"
	"context"
	"encoding/json"
	"os"
	"sort"
	"time"

	"github.com/factorybridge/iotconnector/gateway-go/internal/db"
	"github.com/factorybridge/iotconnector/gateway-go/internal/shadow"
)

// 状态持久化（G3）。写入经 db.Batch 合并为定时事务；未配置 SQLite 时只保留内存数据（测试）。

const (
	historyPointsPerTag = 20000
	alarmHistoryLimit   = 200
	historyRetention    = 7 * 24 * time.Hour
	alarmRetention      = 90 * 24 * time.Hour
)

// stateStore 把 Server 的历史缓冲与告警历史挂到 SQLite 上。
type stateStore struct {
	db    *db.DB
	batch *db.Batch
}

// loadHistory 从 SQLite 读回每个位号最近 historyPointsPerTag 个点；库中没有数据且存在旧
// history.jsonl 时导入它，落盘后原文件改名为 .migrated。
func (st *stateStore) loadHistory(ctx context.Context, legacyPath string) map[string][]historyPoint {
	values := map[string][]historyPoint{}
	if st == nil || st.db == nil {
		return values
	}
	var existing int
	_ = st.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM history_points`).Scan(&existing)
	if existing == 0 && legacyPath != "" {
		st.importLegacyHistory(ctx, legacyPath)
	}
	rows, err := st.db.QueryContext(ctx, `SELECT tag_id, ts, value FROM (
        SELECT tag_id, ts, value, ROW_NUMBER() OVER (PARTITION BY tag_id ORDER BY ts DESC) AS rn FROM history_points)
        WHERE rn <= ? ORDER BY tag_id, ts`, historyPointsPerTag)
	if err != nil {
		return values
	}
	defer rows.Close()
	for rows.Next() {
		var tagID string
		var point historyPoint
		if rows.Scan(&tagID, &point.TS, &point.Value) == nil {
			values[tagID] = append(values[tagID], point)
		}
	}
	return values
}

func (st *stateStore) importLegacyHistory(ctx context.Context, path string) {
	file, err := os.Open(path)
	if err != nil {
		return
	}
	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 64*1024), 1024*1024)
	cutoff := time.Now().Add(-historyRetention).UnixMilli()
	imported := 0
	for scanner.Scan() {
		var point persistedHistoryPoint
		if json.Unmarshal(scanner.Bytes(), &point) != nil || point.TagID == "" || point.TS < cutoff {
			continue // 跳过损坏行与超出保留期的点
		}
		st.batch.Exec(`INSERT INTO history_points(tag_id, ts, value) VALUES (?, ?, ?)`, point.TagID, point.TS, point.Value)
		imported++
		if imported%50000 == 0 {
			if st.batch.Flush(ctx) != nil {
				file.Close()
				return
			}
		}
	}
	file.Close()
	if scanner.Err() != nil || st.batch.Flush(ctx) != nil {
		return // 读取或落盘失败时保留原文件，下次启动重试
	}
	_ = os.Rename(path, path+".migrated")
}

func (st *stateStore) addHistory(tagID string, point historyPoint) {
	if st == nil {
		return
	}
	st.batch.Exec(`INSERT INTO history_points(tag_id, ts, value) VALUES (?, ?, ?)`, tagID, point.TS, point.Value)
}

func (st *stateStore) saveAlarmEvent(event alarmEvent) {
	if st == nil {
		return
	}
	payload, err := json.Marshal(event)
	if err != nil {
		return
	}
	// 确认告警会更新同一事件，用 UPSERT
	st.batch.Exec(`INSERT INTO alarm_events(id, ts, payload) VALUES (?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET payload = excluded.payload`, event.ID, event.TS, string(payload))
}

// loadAlarmHistory 读回最近 limit 条告警事件（新的在前），与内存缓存的顺序一致。
func (st *stateStore) loadAlarmHistory(ctx context.Context, limit int) []alarmEvent {
	if st == nil || st.db == nil {
		return nil
	}
	rows, err := st.db.QueryContext(ctx, `SELECT payload FROM alarm_events ORDER BY ts DESC, rowid DESC LIMIT ?`, limit)
	if err != nil {
		return nil
	}
	defer rows.Close()
	var events []alarmEvent
	for rows.Next() {
		var payload string
		var event alarmEvent
		if rows.Scan(&payload) == nil && json.Unmarshal([]byte(payload), &event) == nil {
			events = append(events, event)
		}
	}
	return events
}

// queryAlarmHistory 支持分页，超出内存缓存的旧事件也能查到。
func (st *stateStore) queryAlarmHistory(ctx context.Context, page, pageSize int) ([]alarmEvent, int, error) {
	if err := st.batch.Flush(ctx); err != nil {
		return nil, 0, err
	}
	var total int
	if err := st.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM alarm_events`).Scan(&total); err != nil {
		return nil, 0, err
	}
	rows, err := st.db.QueryContext(ctx, `SELECT payload FROM alarm_events ORDER BY ts DESC, rowid DESC LIMIT ? OFFSET ?`, pageSize, page*pageSize)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	events := []alarmEvent{}
	for rows.Next() {
		var payload string
		var event alarmEvent
		if rows.Scan(&payload) == nil && json.Unmarshal([]byte(payload), &event) == nil {
			events = append(events, event)
		}
	}
	return events, total, rows.Err()
}

// prune 按保留期清理历史缓冲与告警事件，并把每个位号的点数裁到上限。由 run 定时调用。
func (st *stateStore) prune(ctx context.Context) {
	if st == nil {
		return
	}
	now := time.Now()
	st.batch.Exec(`DELETE FROM history_points WHERE ts < ?`, now.Add(-historyRetention).UnixMilli())
	st.batch.Exec(`DELETE FROM history_points WHERE rowid IN (SELECT rowid FROM (
        SELECT rowid, ROW_NUMBER() OVER (PARTITION BY tag_id ORDER BY ts DESC) AS rn FROM history_points) WHERE rn > ?)`, historyPointsPerTag)
	st.batch.Exec(`DELETE FROM alarm_events WHERE ts < ?`, now.Add(-alarmRetention).UnixMilli())
	_ = st.batch.Flush(ctx)
}

func sortAlarmEventsNewestFirst(events []alarmEvent) {
	sort.SliceStable(events, func(i, j int) bool { return events[i].TS > events[j].TS })
}

// PruneState 按保留期清理历史缓冲与告警事件。
func (s *Server) PruneState(ctx context.Context) { s.state.prune(ctx) }

// newShadowStore 有状态库时用 SQLite（ShadowFile 作为旧文件导入一次），否则退回 JSON 文件。
func newShadowStore(options SecurityOptions) *shadow.Store {
	if options.StateDB != nil && options.State != nil {
		return shadow.NewDB(options.StateDB, options.State, options.ShadowFile, nil)
	}
	return shadow.New(options.ShadowFile, nil)
}
