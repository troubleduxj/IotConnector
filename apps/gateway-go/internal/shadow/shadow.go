package shadow

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"sync"
	"time"
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

type Store struct {
	mu       sync.RWMutex
	path     string
	reported map[string]Reported
	desired  map[string]Desired
	onChange func()
}

func New(path string, onChange func()) *Store {
	s := &Store{path: path, reported: map[string]Reported{}, desired: map[string]Desired{}, onChange: onChange}
	s.load()
	return s
}

func (s *Store) SetReported(tagID string, value any, quality string, ts int64) {
	s.mu.Lock()
	previous, existed := s.reported[tagID]
	s.reported[tagID] = Reported{Value: value, Quality: quality, TS: ts}
	changed := !existed || !reflect.DeepEqual(previous, s.reported[tagID])
	s.persistLocked()
	onChange := s.onChange
	s.mu.Unlock()
	if changed && onChange != nil {
		onChange()
	}
}

func (s *Store) SetDesired(tagID string, value any, by string) {
	s.mu.Lock()
	s.desired[tagID] = Desired{Value: value, TS: time.Now().UnixMilli(), By: by}
	s.persistLocked()
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
	tmp := s.path + ".tmp"
	if os.WriteFile(tmp, b, 0o640) == nil {
		_ = os.Rename(tmp, s.path)
	}
}
