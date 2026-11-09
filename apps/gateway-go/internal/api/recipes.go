package api

import (
	"context"
	"encoding/json"
	"fmt"
	"github.com/factorybridge/iotconnector/gateway-go/internal/acquisition"
	"github.com/factorybridge/iotconnector/gateway-go/internal/audit"
	"net/http"
	"strings"
	"time"
)

type recipeItem struct {
	TagID string `json:"tagId"`
	Value any    `json:"value"`
}
type recipe struct {
	ID          string       `json:"id"`
	Name        string       `json:"name"`
	Description string       `json:"description"`
	Items       []recipeItem `json:"items"`
	UpdatedAt   int64        `json:"updatedAt"`
	Version     int          `json:"version,omitempty"`
}
type recipeDownload struct {
	ID         string `json:"id"`
	RecipeID   string `json:"recipeId"`
	RecipeName string `json:"recipeName"`
	Version    int    `json:"version"`
	At         int64  `json:"at"`
	By         string `json:"by"`
	OK         bool   `json:"ok"`
	OKCount    int    `json:"okCount"`
	TotalCount int    `json:"totalCount"`
}

func (s *Server) recipesSnapshot() []recipe {
	items, ok := s.cfg().Raw["recipes"].([]any)
	if !ok {
		return []recipe{}
	}
	b, _ := json.Marshal(items)
	var result []recipe
	_ = json.Unmarshal(b, &result)
	for i := range result {
		if result[i].Version <= 0 {
			result[i].Version = 1
		}
	}
	return result
}

func (s *Server) saveRecipes(items []recipe) error {
	b, err := json.Marshal(items)
	if err != nil {
		return err
	}
	var raw []any
	if err := json.Unmarshal(b, &raw); err != nil {
		return err
	}
	return s.commitRawLocked("recipes", raw)
}

func actorName(r *http.Request) string {
	if value := actor(r); value != "" {
		return value
	}
	return "api"
}

func (s *Server) recipes(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, s.recipesSnapshot())
}

func (s *Server) createRecipe(w http.ResponseWriter, r *http.Request) {
	var item recipe
	if json.NewDecoder(r.Body).Decode(&item) != nil || strings.TrimSpace(item.Name) == "" {
		writeJSON(w, 400, map[string]any{"ok": false, "error": "name required"})
		return
	}
	item.ID, item.UpdatedAt, item.Version = newID("rcp_"), time.Now().UnixMilli(), 1
	s.configMu.Lock()
	items := s.recipesSnapshot()
	items = append(items, item)
	err := s.saveRecipes(items)
	s.configMu.Unlock()
	if err != nil {
		writeJSON(w, 500, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	writeJSON(w, 201, item)
}

func (s *Server) updateRecipe(w http.ResponseWriter, r *http.Request) {
	var patch struct {
		Name        *string       `json:"name"`
		Description *string       `json:"description"`
		Items       *[]recipeItem `json:"items"`
	}
	if json.NewDecoder(r.Body).Decode(&patch) != nil {
		writeJSON(w, 400, map[string]any{"ok": false, "error": "invalid recipe JSON"})
		return
	}
	s.configMu.Lock()
	defer s.configMu.Unlock()
	items := s.recipesSnapshot()
	index := -1
	for i := range items {
		if items[i].ID == r.PathValue("recipeID") {
			index = i
			break
		}
	}
	if index < 0 {
		writeJSON(w, 404, map[string]any{"ok": false, "error": "recipe not found"})
		return
	}
	current := &items[index]
	changed := patch.Items != nil && !sameJSON(current.Items, *patch.Items)
	if patch.Name != nil {
		current.Name = *patch.Name
	}
	if patch.Description != nil {
		current.Description = *patch.Description
	}
	if patch.Items != nil {
		current.Items = *patch.Items
	}
	current.UpdatedAt = time.Now().UnixMilli()
	if changed {
		current.Version++
	}
	if err := s.saveRecipes(items); err != nil {
		writeJSON(w, 500, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	writeJSON(w, 200, current)
}

func sameJSON(a, b any) bool {
	left, _ := json.Marshal(a)
	right, _ := json.Marshal(b)
	return string(left) == string(right)
}

func (s *Server) deleteRecipe(w http.ResponseWriter, r *http.Request) {
	s.configMu.Lock()
	defer s.configMu.Unlock()
	old := s.recipesSnapshot()
	next := make([]recipe, 0, len(old))
	found := false
	for _, item := range old {
		if item.ID == r.PathValue("recipeID") {
			found = true
		} else {
			next = append(next, item)
		}
	}
	if !found {
		writeJSON(w, 404, map[string]any{"ok": false, "error": "recipe not found"})
		return
	}
	if err := s.saveRecipes(next); err != nil {
		writeJSON(w, 500, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true})
}

func (s *Server) downloadRecipe(w http.ResponseWriter, r *http.Request) {
	recipes := s.recipesSnapshot()
	var selected *recipe
	for i := range recipes {
		if recipes[i].ID == r.PathValue("recipeID") {
			selected = &recipes[i]
			break
		}
	}
	if selected == nil {
		writeJSON(w, 404, map[string]any{"ok": false, "error": "recipe not found"})
		return
	}
	results := make([]map[string]any, 0, len(selected.Items))
	okCount := 0
	for _, item := range selected.Items {
		var tagName string
		for _, tag := range s.cfg().Tags {
			if tag.ID == item.TagID {
				tagName = tag.Name
				break
			}
		}
		if tagName == "" {
			results = append(results, map[string]any{"tagId": item.TagID, "value": item.Value, "ok": false, "error": "tag not found"})
			continue
		}
		err := s.engine.Write(context.Background(), item.TagID, decodeAnyValue(item.Value))
		if err == nil {
			okCount++
			s.shadowStore.SetDesired(item.TagID, item.Value, actorName(r))
			s.scheduleShadowPublish()
		}
		detail := map[string]any{"value": item.Value}
		if err != nil {
			detail["error"] = err.Error()
		}
		_ = s.audit.Record(auditEvent("recipe.download", selected.Name+": "+tagName, detail))
		entry := map[string]any{"tagId": item.TagID, "name": tagName, "value": item.Value, "ok": err == nil}
		if err != nil {
			entry["error"] = err.Error()
		}
		results = append(results, entry)
	}
	record := recipeDownload{ID: newID("dl_"), RecipeID: selected.ID, RecipeName: selected.Name, Version: selected.Version, At: time.Now().UnixMilli(), By: actorName(r), OK: okCount == len(results), OKCount: okCount, TotalCount: len(results)}
	s.configMu.Lock()
	records := s.recipeDownloadsSnapshot()
	records = append([]recipeDownload{record}, records...)
	if len(records) > 200 {
		records = records[:200]
	}
	_ = s.saveRecipeDownloads(records)
	s.configMu.Unlock()
	writeJSON(w, 200, map[string]any{"ok": record.OK, "results": results})
}

func decodeAnyValue(value any) acquisition.Value {
	switch v := value.(type) {
	case bool:
		return acquisition.BoolValue(v)
	case string:
		return acquisition.StringValue(v)
	case float64:
		return acquisition.NumberValue(v)
	// inline 脚本（goja）把整数交给 Go 时是 int64，不经 JSON；原先落到 default 被当成字符串写入。
	case int64:
		return acquisition.NumberValue(float64(v))
	case int:
		return acquisition.NumberValue(float64(v))
	case int32:
		return acquisition.NumberValue(float64(v))
	case float32:
		return acquisition.NumberValue(float64(v))
	default:
		return acquisition.StringValue(fmt.Sprint(v))
	}
}

func auditEvent(action, target string, detail map[string]any) audit.Event {
	return audit.Event{Actor: "api", Action: action, Target: target, Detail: detail}
}

func (s *Server) recipeDownloads(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, 200, s.recipeDownloadsSnapshot())
}
func (s *Server) recipeDownloadsSnapshot() []recipeDownload {
	items, ok := s.cfg().Raw["recipeDownloads"].([]any)
	if !ok {
		return []recipeDownload{}
	}
	b, _ := json.Marshal(items)
	var out []recipeDownload
	_ = json.Unmarshal(b, &out)
	return out
}
func (s *Server) saveRecipeDownloads(items []recipeDownload) error {
	b, _ := json.Marshal(items)
	var raw []any
	_ = json.Unmarshal(b, &raw)
	return s.commitRawLocked("recipeDownloads", raw)
}

func (s *Server) duplicateRecipe(w http.ResponseWriter, r *http.Request) {
	for _, item := range s.recipesSnapshot() {
		if item.ID == r.PathValue("recipeID") {
			item.ID = newID("rcp_")
			item.Name += " 副本"
			item.UpdatedAt = time.Now().UnixMilli()
			item.Version = 1
			s.configMu.Lock()
			all := s.recipesSnapshot()
			all = append(all, item)
			err := s.saveRecipes(all)
			s.configMu.Unlock()
			if err != nil {
				writeJSON(w, 500, map[string]any{"ok": false, "error": err.Error()})
				return
			}
			writeJSON(w, 201, item)
			return
		}
	}
	writeJSON(w, 404, map[string]any{"ok": false, "error": "recipe not found"})
}

func (s *Server) exportRecipe(w http.ResponseWriter, r *http.Request) {
	for _, item := range s.recipesSnapshot() {
		if item.ID != r.PathValue("recipeID") {
			continue
		}
		bundle := map[string]any{"format": "factorybridge-recipe@1", "exportedAt": time.Now().UTC().Format(time.RFC3339), "recipe": map[string]any{"name": item.Name, "description": item.Description, "version": item.Version, "items": item.Items}}
		w.Header().Set("Content-Disposition", `attachment; filename="recipe.json"`)
		writeJSON(w, 200, bundle)
		return
	}
	writeJSON(w, 404, map[string]any{"ok": false, "error": "recipe not found"})
}

func (s *Server) importRecipe(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Recipe struct {
			Name        string       `json:"name"`
			Description string       `json:"description"`
			Items       []recipeItem `json:"items"`
		} `json:"recipe"`
	}
	if json.NewDecoder(r.Body).Decode(&body) != nil || strings.TrimSpace(body.Recipe.Name) == "" {
		writeJSON(w, 400, map[string]any{"ok": false, "error": "recipe.name required"})
		return
	}
	for _, item := range s.recipesSnapshot() {
		if item.Name == body.Recipe.Name {
			writeJSON(w, 409, map[string]any{"ok": false, "error": "recipe name already exists"})
			return
		}
	}
	for _, item := range body.Recipe.Items {
		found := false
		for _, tag := range s.cfg().Tags {
			if tag.ID == item.TagID {
				found = true
				break
			}
		}
		if !found {
			writeJSON(w, 400, map[string]any{"ok": false, "error": "tag not found", "details": []string{item.TagID}})
			return
		}
	}
	item := recipe{ID: newID("rcp_"), Name: body.Recipe.Name, Description: body.Recipe.Description, Items: body.Recipe.Items, UpdatedAt: time.Now().UnixMilli(), Version: 1}
	s.configMu.Lock()
	all := s.recipesSnapshot()
	all = append(all, item)
	err := s.saveRecipes(all)
	s.configMu.Unlock()
	if err != nil {
		writeJSON(w, 500, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	writeJSON(w, 201, item)
}
