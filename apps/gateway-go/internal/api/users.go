package api

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"

	"github.com/factorybridge/iotconnector/gateway-go/internal/auth"
)

// 用户与会话管理接口（H4）。全部要求 admin，且只对用户会话开放：
// 静态令牌（token:admin）不能管理用户，避免令牌泄露后被用来创建持久账号。

func (s *Server) requireUserSession(w http.ResponseWriter, r *http.Request) bool {
	if s.users == nil {
		writeJSON(w, http.StatusNotImplemented, map[string]any{"ok": false, "error": "user store is not configured"})
		return false
	}
	if principal(r).UserID == "" && !s.devNoAuth {
		writeJSON(w, http.StatusForbidden, map[string]any{"ok": false, "error": "user management requires a signed-in admin"})
		return false
	}
	return true
}

func userErrorStatus(err error) int {
	switch {
	case errors.Is(err, auth.ErrUserNotFound):
		return http.StatusNotFound
	case errors.Is(err, auth.ErrUserExists), errors.Is(err, auth.ErrLastAdmin):
		return http.StatusConflict
	default:
		return http.StatusBadRequest
	}
}

func (s *Server) listUsers(w http.ResponseWriter, r *http.Request) {
	if !s.requireUserSession(w, r) {
		return
	}
	users, err := s.users.ListUsers(r.Context())
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, users)
}

func (s *Server) createUser(w http.ResponseWriter, r *http.Request) {
	if !s.requireUserSession(w, r) {
		return
	}
	var request struct {
		Username string `json:"username"`
		Password string `json:"password"`
		Role     Role   `json:"role"`
	}
	if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": "invalid JSON body"})
		return
	}
	// 管理员设置的初始口令只有管理员知道，用户首次登录后必须修改。
	user, err := s.users.CreateUser(r.Context(), request.Username, request.Password, request.Role, true)
	if err != nil {
		writeJSON(w, userErrorStatus(err), map[string]any{"ok": false, "error": err.Error()})
		return
	}
	s.recordAudit(r, actor(r), "user.create", user.ID, map[string]any{"username": user.Username, "role": user.Role})
	writeJSON(w, http.StatusCreated, user)
}

func (s *Server) updateUser(w http.ResponseWriter, r *http.Request) {
	if !s.requireUserSession(w, r) {
		return
	}
	var request struct {
		Role     *Role   `json:"role"`
		Password *string `json:"password"`
		Disabled *bool   `json:"disabled"`
	}
	if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": "invalid JSON body"})
		return
	}
	id := r.PathValue("userID")
	if id == principal(r).UserID && ((request.Role != nil && *request.Role != RoleAdmin) || (request.Disabled != nil && *request.Disabled)) {
		writeJSON(w, http.StatusConflict, map[string]any{"ok": false, "error": "cannot demote or disable yourself"})
		return
	}
	user, err := s.users.UpdateUser(r.Context(), id, auth.UserPatch{Role: request.Role, Password: request.Password, Disabled: request.Disabled})
	if err != nil {
		writeJSON(w, userErrorStatus(err), map[string]any{"ok": false, "error": err.Error()})
		return
	}
	detail := map[string]any{"username": user.Username}
	if request.Role != nil {
		detail["role"] = *request.Role
	}
	if request.Disabled != nil {
		detail["disabled"] = *request.Disabled
	}
	if request.Password != nil {
		detail["passwordReset"] = true
	}
	s.recordAudit(r, actor(r), "user.update", id, detail)
	writeJSON(w, http.StatusOK, user)
}

func (s *Server) deleteUser(w http.ResponseWriter, r *http.Request) {
	if !s.requireUserSession(w, r) {
		return
	}
	id := r.PathValue("userID")
	if id == principal(r).UserID {
		writeJSON(w, http.StatusConflict, map[string]any{"ok": false, "error": "cannot delete yourself"})
		return
	}
	if err := s.users.DeleteUser(r.Context(), id); err != nil {
		writeJSON(w, userErrorStatus(err), map[string]any{"ok": false, "error": err.Error()})
		return
	}
	s.recordAudit(r, actor(r), "user.delete", id, nil)
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (s *Server) unlockUser(w http.ResponseWriter, r *http.Request) {
	if !s.requireUserSession(w, r) {
		return
	}
	id := r.PathValue("userID")
	if err := s.users.Unlock(r.Context(), id); err != nil {
		writeJSON(w, userErrorStatus(err), map[string]any{"ok": false, "error": err.Error()})
		return
	}
	s.recordAudit(r, actor(r), "user.unlock", id, nil)
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (s *Server) listSessions(w http.ResponseWriter, r *http.Request) {
	if !s.requireUserSession(w, r) {
		return
	}
	sessions, err := s.users.ListSessions(r.Context())
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	current := principal(r).SessionID
	out := make([]map[string]any, 0, len(sessions))
	for _, item := range sessions {
		out = append(out, map[string]any{"id": item.ID, "userId": item.UserID, "username": item.Username, "createdAt": item.CreatedAt,
			"expiresAt": item.ExpiresAt, "lastSeenAt": item.LastSeenAt, "clientIp": item.ClientIP, "userAgent": item.UserAgent, "current": item.ID == current})
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) revokeSession(w http.ResponseWriter, r *http.Request) {
	if !s.requireUserSession(w, r) {
		return
	}
	id := r.PathValue("sessionID")
	ok, err := s.users.RevokeSession(r.Context(), id)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	if !ok {
		writeJSON(w, http.StatusNotFound, map[string]any{"ok": false, "error": "session not found"})
		return
	}
	s.recordAudit(r, actor(r), "session.revoke", id, nil)
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// auditLog 返回最近的审计事件，字段对齐控制台 AuditEntry（ts/user/role/action/detail）。
func (s *Server) auditLog(w http.ResponseWriter, r *http.Request) {
	limit := 200
	if value, err := strconv.Atoi(r.URL.Query().Get("limit")); err == nil && value > 0 && value <= 2000 {
		limit = value
	}
	events, err := s.audit.Recent(limit)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	out := make([]map[string]any, 0, len(events))
	for _, event := range events {
		detail, _ := json.Marshal(event.Detail)
		text := event.Target
		if len(event.Detail) > 0 {
			if text != "" {
				text += " "
			}
			text += string(detail)
		}
		out = append(out, map[string]any{"ts": event.At.UnixMilli(), "user": event.Actor, "role": "", "action": event.Action, "detail": text})
	}
	writeJSON(w, http.StatusOK, map[string]any{"events": out})
}
