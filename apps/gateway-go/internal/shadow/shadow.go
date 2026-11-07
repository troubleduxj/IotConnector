package shadow

import (
	"context"
	"database/sql"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"sync"
	"time"

	"github.com/factorybridge/iotconnector/gateway-go/internal/db"
)

type Reported struct {
	Value   any    `json:"value"`
	Quality string `json:"quality"`
	TS      int64  `json:"ts"`
}

type Desired struct {
	Value any    `json:"value"`
	TS    int64  `json:"ts"`
	By    string `json:"by"`
}

type Entry struct {
	TagID    string    `json:"tagId"`
	Reported *Reported `json:"reported,omitempty"`
	Desired  *Desired  `json:"desired,omitempty"`
}

type fileState struct {
	Version  int                 `json:"version"`
	Reported []persistedReported `json:"reported"`
	Desired  []persistedDesired  `json:"desired"`
}

type persistedReported struct {
	TagID   string `json:"tagId"`
	Value   any    `json:"value"`
	Quality string `json:"quality"`
	TS      int64  `json:"ts"`
}

type persistedDesired struct {
	TagID string `json:"tagId"`
	Value any    `json:"value"`
	TS    int64  `json:"ts"`
	By    string `json:"by"`
}

// Store 是设备影子。配置了 SQLite 时每个位号一行，变化时只写该行（G4）；
// 否则写 JSON 文件（测试与旧调用方）。原实现每个 SetReported 都重写整个文件且临时文件名固定、无 fsync。
type Store struct {
	mu       sync.RWMutex
	path     string
	batch    *db.Batch
	reported map[string]Reported
	desired  map[string]Desired
	onChange func()
}

func New(path string, onChange func()) *Store {
	s := &Store{path: path, reported: map[string]Reported{}, desired: map[string]Desired{}, onChange: onChange}
	s.load()
	return s
}

// NewDB 从 SQLite 恢复影子；库为空且存在旧 shadow.json 时导入一次，落盘后原文件改名为 .migrated。
func NewDB(database *db.DB, batch *db.Batch, legacyPath string, onChange func()) *Store {
	s := &Store{batch: batch, reported: map[string]Reported{}, desired: map[string]Desired{}, onChange: onChange}
	rows, err := database.Query(`SELECT tag_id, reported, desired FROM shadow_entries`)
	if err == nil {
		for rows.Next() {
			var id string
			var reported, desired sql.NullString
			if rows.Scan(&id, &reported, &desired) != nil {
				continue
			}
			if reported.Valid {
				var value Reported
				if json.Unmarshal([]byte(reported.String), &value) == nil {
					s.reported[id] = value
				}
			}
			if desired.Valid {
				var value Desired
				if json.Unmarshal([]byte(desired.String), &value) == nil {
					s.desired[id] = value
				}
			}
		}
		rows.Close()
	}
	if len(s.reported) == 0 && len(s.desired) == 0 && legacyPath != "" {
		s.path = legacyPath
		s.load()
		s.path = ""
		if len(s.reported) > 0 || len(s.desired) > 0 {
			for id := range s.reported {
				s.writeRowLocked(id)
			}
			for id := range s.desired {
				s.writeRowLocked(id)
			}
			if batch.Flush(context.Background()) == nil {
				_ = os.Rename(legacyPath, legacyPath+".migrated")
			}
		}
	}
	return s
}

// writeRowLocked 把一个位号的当前影子写入 SQLite（UPSERT 整行）。
func (s *Store) writeRowLocked(tagID string) {
	var reported, desired any
	if value, ok := s.reported[tagID]; ok {
		if b, err := json.Marshal(value); err == nil {
			reported = string(b)
		}
	}
	if value, ok := s.desired[tagID]; ok {
		if b, err := json.Marshal(value); err == nil {
			desired = string(b)
		}
	}
	s.batch.Exec(`INSERT INTO shadow_entries(tag_id, reported, desired) VALUES (?, ?, ?)
        ON CONFLICT(tag_id) DO UPDATE SET reported = excluded.reported, desired = excluded.desired`, tagID, reported, desired)
}

func (s *Store) changedLocked(tagID string) {
	if s.batch != nil {
		s.writeRowLocked(tagID)
		return
	}
	s.persistLocked()
}

func (s *Store) SetReported(tagID string, value any, quality string, ts int64) {
	s.mu.Lock()
	previous, existed := s.reported[tagID]
	s.reported[tagID] = Reported{Value: value, Quality: quality, TS: ts}
	changed := !existed || !reflect.DeepEqual(previous, s.reported[tagID])
	// 值、质量码、时间戳都没变时不写库：采样周期内重复上报同一快照很常见
	if changed {
		s.changedLocked(tagID)
	}
	onChange := s.onChange
	s.mu.Unlock()
	if changed && onChange != nil {
		onChange()
	}
}

func (s *Store) SetDesired(tagID string, value any, by string) {
	s.mu.Lock()
	s.desired[tagID] = Desired{Value: value, TS: time.Now().UnixMilli(), By: by}
	s.changedLocked(tagID)
	onChange := s.onChange
	s.mu.Unlock()
	if onChange != nil {
		onChange()
	}
}

func (s *Store) Snapshot() []Entry {
	s.mu.RLock()
	defer s.mu.RUnlock()
	ids := make(map[string]struct{}, len(s.reported)+len(s.desired))
	for id := range s.reported {
		ids[id] = struct{}{}
	}
	for id := range s.desired {
		ids[id] = struct{}{}
	}
	out := make([]Entry, 0, len(ids))
	for id := range ids {
		entry := Entry{TagID: id}
		if value, ok := s.reported[id]; ok {
			copy := value
			entry.Reported = &copy
		}
		if value, ok := s.desired[id]; ok {
			copy := value
			entry.Desired = &copy
		}
		out = append(out, entry)
	}
	return out
}

func (s *Store) PendingCount() int {
	count := 0
	for _, entry := range s.Snapshot() {
		if entry.Desired != nil && (entry.Reported == nil || !reflect.DeepEqual(entry.Desired.Value, entry.Reported.Value)) {
			count++
		}
	}
	return count
}

func (s *Store) load() {
	if s.path == "" {
		return
	}
	b, err := os.ReadFile(s.path)
	if err != nil {
		return
	}
	var state fileState
	if json.Unmarshal(b, &state) != nil || state.Version != 1 {
		return
	}
	for _, item := range state.Reported {
		s.reported[item.TagID] = Reported{Value: item.Value, Quality: item.Quality, TS: item.TS}
	}
	for _, item := range state.Desired {
		s.desired[item.TagID] = Desired{Value: item.Value, TS: item.TS, By: item.By}
	}
}

func (s *Store) persistLocked() {
	if s.path == "" {
		return
	}
	state := fileState{Version: 1, Reported: make([]persistedReported, 0, len(s.reported)), Desired: make([]persistedDesired, 0, len(s.desired))}
	for id, value := range s.reported {
		state.Reported = append(state.Reported, persistedReported{TagID: id, Value: value.Value, Quality: value.Quality, TS: value.TS})
	}
	for id, value := range s.desired {
		state.Desired = append(state.Desired, persistedDesired{TagID: id, Value: value.Value, TS: value.TS, By: value.By})
	}
	b, err := json.MarshalIndent(state, "", "  ")
	if err != nil {
		return
	}
	if os.MkdirAll(filepath.Dir(s.path), 0o750) != nil {
		return
	}
	tmp, err := os.CreateTemp(filepath.Dir(s.path), ".shadow-*.json")
	if err != nil {
		return
	}
	name := tmp.Name()
	defer os.Remove(name)
	if _, err := tmp.Write(b); err != nil || tmp.Sync() != nil {
		_ = tmp.Close()
		return
	}
	if tmp.Close() == nil {
		_ = os.Rename(name, s.path)
	}
}
