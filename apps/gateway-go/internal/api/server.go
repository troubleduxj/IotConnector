package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"mime"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"reflect"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/factorybridge/iotconnector/gateway-go/internal/acquisition"
	"github.com/factorybridge/iotconnector/gateway-go/internal/audit"
	"github.com/factorybridge/iotconnector/gateway-go/internal/auth"
	"github.com/factorybridge/iotconnector/gateway-go/internal/config"
	"github.com/factorybridge/iotconnector/gateway-go/internal/db"
	"github.com/factorybridge/iotconnector/gateway-go/internal/domain"
	"github.com/factorybridge/iotconnector/gateway-go/internal/northbound"
	"github.com/factorybridge/iotconnector/gateway-go/internal/shadow"
	"github.com/factorybridge/iotconnector/gateway-go/internal/storage"
	"github.com/factorybridge/iotconnector/gateway-go/internal/version"
)

type Server struct {
	startedAt           time.Time
	cfgPtr              atomic.Pointer[config.Config]
	engine              *acquisition.Engine
	credentials         map[string]Role
	users               *auth.UserStore
	devMode             bool
	web                 http.Handler
	allowedClients      []netip.Prefix
	closeWeb            func() error
	devNoAuth           bool
	audit               *audit.Logger
	cors                map[string]struct{}
	limiterMu           sync.Mutex
	failures            map[string]authFailure
	failureLimit        int
	failureWindow       time.Duration
	ws                  *wsHub
	configStore         *config.Store
	configMu            sync.RWMutex
	state               *stateStore
	historyStore        *historyStore
	alarms              *alarmManager
	storage             *storage.Writer
	taskEngine          *storageTaskEngine
	northboundPublisher *northbound.Publisher
	shadowStore         *shadow.Store
	shadowMu            sync.Mutex
	shadowTimer         *time.Timer
	scriptEngine        *scriptEngine
}

type SecurityOptions struct {
	Token         string // Backward-compatible operator token.
	ViewerToken   string
	OperatorToken string
	AdminToken    string
	// Users 为空时只能用静态令牌访问（测试与无人值守场景）；生产由 run 命令打开 SQLite 后传入。
	Users *auth.UserStore
	// AllowedClients 非空时只接受这些网段的连接（含页面、API、WebSocket），其余 403（F2）。
	AllowedClients []netip.Prefix
	// WebDir 是控制台构建产物目录；存在 index.html 时网关同端口托管页面（F1）。
	WebDir string
	// DevMode 放行 http://localhost:* 与 http://127.0.0.1:* 来源（Vite 开发服务器），
	// 并在 /api/system/info 与 /api/auth/me 中标明。绑定地址由 run 命令强制为回环。
	DevMode bool
	// DevNoAuth 仅开发模式可用：所有请求按 admin 处理。
	DevNoAuth bool
	// StateDB/State 为空时历史与告警只保留在内存（测试）。HistoryFile 是旧 history.jsonl，首次启动导入。
	StateDB       *db.DB
	State         *db.Batch
	HistoryFile   string
	Audit         *audit.Logger
	ConfigStore   *config.Store
	Storage       *storage.Writer
	ShadowFile    string
	CORSOrigins   []string
	FailureLimit  int
	FailureWindow time.Duration
}

type Role = auth.Role

const (
	RoleViewer   = auth.RoleViewer
	RoleOperator = auth.RoleOperator
	RoleEngineer = auth.RoleEngineer
	RoleAdmin    = auth.RoleAdmin
)

type authFailure struct {
	started time.Time
	count   int
}

func NewServer(cfg config.Config, engine *acquisition.Engine) *Server {
	return NewServerWithOptions(cfg, engine, SecurityOptions{})
}

func NewServerWithSecurity(cfg config.Config, engine *acquisition.Engine, authToken string, auditLog *audit.Logger) *Server {
	return NewServerWithOptions(cfg, engine, SecurityOptions{Token: authToken, Audit: auditLog})
}

func NewServerWithOptions(cfg config.Config, engine *acquisition.Engine, options SecurityOptions) *Server {
	origins := make(map[string]struct{}, len(options.CORSOrigins))
	for _, origin := range options.CORSOrigins {
		if trimmed := strings.TrimSpace(origin); trimmed != "" {
			origins[trimmed] = struct{}{}
		}
	}
	if options.FailureLimit <= 0 {
		options.FailureLimit = 5
	}
	if options.FailureWindow <= 0 {
		options.FailureWindow = time.Minute
	}
	credentials := make(map[string]Role)
	if options.ViewerToken != "" {
		credentials[options.ViewerToken] = RoleViewer
	}
	if options.Token != "" {
		credentials[options.Token] = RoleOperator
	}
	if options.OperatorToken != "" {
		credentials[options.OperatorToken] = RoleOperator
	}
	if options.AdminToken != "" {
		credentials[options.AdminToken] = RoleAdmin
	}
	var state *stateStore
	if options.StateDB != nil && options.State != nil {
		state = &stateStore{db: options.StateDB, batch: options.State}
	}
	server := &Server{
		startedAt: time.Now(), engine: engine, credentials: credentials, audit: options.Audit,
		users: options.Users, devMode: options.DevMode || options.DevNoAuth, devNoAuth: options.DevNoAuth,
		cors: origins, failures: make(map[string]authFailure),
		failureLimit: options.FailureLimit, failureWindow: options.FailureWindow,
		configStore:  options.ConfigStore,
		state:        state,
		historyStore: newHistoryStore(state, options.HistoryFile),
		alarms:       newAlarmManager(cfg.Raw["alarms"]),
		storage:      options.Storage,
		shadowStore:  newShadowStore(options),
	}
	initial := cfg.Clone()
	server.cfgPtr.Store(&initial)
	server.web, server.closeWeb = newWebHandler(options.WebDir)
	server.allowedClients = options.AllowedClients
	server.alarms.state = state
	server.alarms.history = state.loadAlarmHistory(context.Background(), alarmHistoryLimit)
	server.ws = newWSHub()
	engine.SetOnSample(func(sample acquisition.Sample) {
		server.historyStore.add(sample)
		if server.storage != nil {
			for _, tag := range server.cfg().Tags {
				if tag.ID == sample.TagID {
					server.storage.Enqueue(acquisition.Tag{ID: tag.ID, Name: tag.Name, ChannelID: tag.ChannelID, DataType: tag.DataType}, sample)
					break
				}
			}
		}
		if server.taskEngine != nil {
			server.taskEngine.onSample(sample)
			server.taskEngine.onBoolSample(sample)
		}
		if server.northboundPublisher != nil {
			server.northboundPublisher.PublishSample(sample)
		}
		if server.scriptEngine != nil {
			server.scriptEngine.onSample(sample)
		}
		server.shadowStore.SetReported(sample.TagID, wireValue(sample.Value), string(sample.Quality), sample.SampledAt)
		server.scheduleShadowPublish()
		for _, tag := range server.cfg().Tags {
			if tag.ID == sample.TagID {
				server.alarms.evaluate(tag, sample)
				break
			}
		}
		server.ws.broadcast(map[string]any{"type": "tags-batch", "values": wireSamples([]acquisition.Sample{sample})}, true)
	})
	server.alarms.onEvent = func(event alarmEvent) {
		server.ws.broadcast(map[string]any{"type": "alarm", "event": event}, true)
		server.dispatchNotification(event)
		if server.storage != nil && server.storage.Enabled() {
			server.storage.EnqueueAlarmEvent(storage.AlarmEvent{ID: event.ID, RuleID: event.RuleID, TagID: event.TagID, TagName: event.TagName, Channel: event.Channel, State: event.State, Kind: event.Kind, Threshold: event.Threshold, Value: event.Value, Timestamp: event.TS, Message: event.Message})
		}
	}
	server.taskEngine = newStorageTaskEngine(server)
	server.scriptEngine = newScriptEngine(server)
	server.scriptEngine.configure()
	engine.SetOnStatus(func(status acquisition.ChannelStatus) {
		server.ws.broadcast(map[string]any{"type": "channel-status", "status": status}, false)
	})
	return server
}

func (s *Server) AttachNorthbound(publisher *northbound.Publisher) { s.northboundPublisher = publisher }

func (s *Server) SetShadowDesiredByName(name string, value any, by string) {
	for _, tag := range s.cfg().Tags {
		if tag.Name == name {
			s.shadowStore.SetDesired(tag.ID, value, by)
			s.scheduleShadowPublish()
			return
		}
	}
}

func (s *Server) scheduleShadowPublish() {
	s.shadowMu.Lock()
	defer s.shadowMu.Unlock()
	if s.northboundPublisher == nil || s.shadowTimer != nil {
		return
	}
	s.shadowTimer = time.AfterFunc(3*time.Second, func() {
		s.shadowMu.Lock()
		s.shadowTimer = nil
		s.shadowMu.Unlock()
		if s.northboundPublisher != nil {
			s.northboundPublisher.PublishShadow(s.shadowSnapshot())
		}
	})
}

func (s *Server) shadowSnapshot() []map[string]any {
	entries := s.shadowStore.Snapshot()
	result := make([]map[string]any, 0, len(entries))
	for _, entry := range entries {
		for _, tag := range s.cfg().Tags {
			if tag.ID != entry.TagID {
				continue
			}
			item := map[string]any{"tagId": tag.ID, "name": tag.Name, "channel": tag.ChannelID}
			if entry.Reported != nil {
				item["reported"] = entry.Reported
			}
			if entry.Desired != nil {
				item["desired"] = entry.Desired
			}
			pending := entry.Desired != nil && (entry.Reported == nil || !reflect.DeepEqual(entry.Desired.Value, entry.Reported.Value))
			if pending {
				item["state"] = "pending"
			} else {
				item["state"] = "reported"
			}
			result = append(result, item)
			break
		}
	}
	return result
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	s.route(mux, "GET /metrics", viewerOnly, s.prometheusMetrics)
	s.route(mux, "GET /api/health", public, s.health)
	s.route(mux, "GET /api/metrics", viewerOnly, s.metrics)
	s.route(mux, "GET /api/system/info", viewerOnly, s.systemInfo)
	s.route(mux, "POST /api/system/db-test", engineerOnly, s.dbTest)
	s.route(mux, "POST /api/system/db-init", engineerOnly, s.dbInit)
	s.route(mux, "GET /api/channels", viewerOnly, s.channels)
	s.route(mux, "POST /api/channels", engineerOnly, s.createChannel)
	s.route(mux, "PUT /api/channels/{channelID}", engineerOnly, s.updateChannel)
	s.route(mux, "GET /api/channels/{channelID}/driver", operatorOnly, s.getChannelDriver)
	s.route(mux, "PUT /api/channels/{channelID}/driver", adminOnly, s.updateChannelDriver)
	s.route(mux, "DELETE /api/channels/{channelID}", adminOnly, s.deleteChannel)
	s.route(mux, "POST /api/channels/{channelID}/test", engineerOnly, s.testChannel)
	s.route(mux, "GET /api/tags", viewerOnly, s.tags)
	s.route(mux, "POST /api/tags", engineerOnly, s.createTag)
	s.route(mux, "PUT /api/tags/{tagID}", engineerOnly, s.updateTag)
	s.route(mux, "DELETE /api/tags/{tagID}", engineerOnly, s.deleteTag)
	s.route(mux, "GET /api/config", viewerOnly, s.fullConfig)
	s.route(mux, "GET /api/scheduler", viewerOnly, s.scheduler)
	s.route(mux, "GET /api/alarms", viewerOnly, s.alarmResponse)
	s.route(mux, "POST /api/alarms", engineerOnly, s.createAlarm)
	s.route(mux, "PUT /api/alarms/{alarmID}", engineerOnly, s.updateAlarm)
	s.route(mux, "DELETE /api/alarms/{alarmID}", engineerOnly, s.deleteAlarm)
	s.route(mux, "POST /api/alarms/events/{eventID}/ack", operatorOnly, s.ackAlarm)
	s.route(mux, "GET /api/alarms/history", viewerOnly, s.alarmHistory)
	s.route(mux, "GET /api/history", viewerOnly, s.history)
	s.route(mux, "GET /api/storage-tasks", viewerOnly, s.storageTasks)
	s.route(mux, "GET /api/storage-tasks/stats", viewerOnly, s.storageTaskStats)
	s.route(mux, "POST /api/storage-tasks", engineerOnly, s.createStorageTask)
	s.route(mux, "PUT /api/storage-tasks/{taskID}", engineerOnly, s.updateStorageTask)
	s.route(mux, "DELETE /api/storage-tasks/{taskID}", engineerOnly, s.deleteStorageTask)
	s.route(mux, "GET /api/notifications", viewerOnly, s.notifications)
	s.route(mux, "PUT /api/notifications", engineerOnly, s.updateNotifications)
	s.route(mux, "PUT /api/notifications/v2", engineerOnly, s.updateNotifications)
	s.route(mux, "POST /api/notifications/test", engineerOnly, s.testNotification)
	s.route(mux, "GET /api/recipes", viewerOnly, s.recipes)
	s.route(mux, "POST /api/recipes", engineerOnly, s.createRecipe)
	s.route(mux, "PUT /api/recipes/{recipeID}", engineerOnly, s.updateRecipe)
	s.route(mux, "DELETE /api/recipes/{recipeID}", engineerOnly, s.deleteRecipe)
	s.route(mux, "POST /api/recipes/{recipeID}/download", operatorOnly, s.downloadRecipe)
	s.route(mux, "GET /api/recipes/downloads", viewerOnly, s.recipeDownloads)
	s.route(mux, "POST /api/recipes/{recipeID}/duplicate", engineerOnly, s.duplicateRecipe)
	s.route(mux, "GET /api/recipes/{recipeID}/export", engineerOnly, s.exportRecipe)
	s.route(mux, "POST /api/recipes/import", engineerOnly, s.importRecipe)
	s.route(mux, "GET /api/scripts", viewerOnly, s.scriptsAPI)
	s.route(mux, "POST /api/scripts", engineerOnly, s.createScript)
	s.route(mux, "PUT /api/scripts/{scriptID}", engineerOnly, s.updateScript)
	s.route(mux, "DELETE /api/scripts/{scriptID}", engineerOnly, s.deleteScript)
	s.route(mux, "POST /api/scripts/{scriptID}/run", operatorOnly, s.runScript)
	s.route(mux, "GET /api/scripts/{scriptID}/output", viewerOnly, s.scriptOutput)
	s.route(mux, "GET /api/shadow", viewerOnly, s.shadow)
	s.route(mux, "GET /api/northbound", viewerOnly, s.northbound)
	s.route(mux, "PUT /api/northbound", engineerOnly, s.updateNorthbound)
	s.route(mux, "POST /api/northbound/rebirth", engineerOnly, s.rebirthNorthbound)
	s.route(mux, "GET /api/tags/live", viewerOnly, s.liveTags)
	s.route(mux, "POST /api/tags/{tagID}/write", operatorOnly, s.writeTag)
	s.route(mux, "POST /api/auth/login", public, s.login)
	s.route(mux, "GET /api/auth/me", signedIn, s.me)
	s.route(mux, "POST /api/auth/logout", signedIn, s.logout)
	s.route(mux, "POST /api/auth/password", signedIn, s.changePassword)
	s.route(mux, "POST /api/auth/change-password", signedIn, s.changePassword)
	s.route(mux, "GET /api/users", adminOnly, s.listUsers)
	s.route(mux, "POST /api/users", adminOnly, s.createUser)
	s.route(mux, "PUT /api/users/{userID}", adminOnly, s.updateUser)
	s.route(mux, "DELETE /api/users/{userID}", adminOnly, s.deleteUser)
	s.route(mux, "POST /api/users/{userID}/unlock", adminOnly, s.unlockUser)
	s.route(mux, "GET /api/auth/sessions", adminOnly, s.listSessions)
	s.route(mux, "DELETE /api/auth/sessions/{sessionID}", adminOnly, s.revokeSession)
	s.route(mux, "GET /api/audit", adminOnly, s.auditLog)
	// 控制台功能缺口（与 Node 网关同名同权限）
	s.route(mux, "GET /api/channels/{channelID}/export", engineerOnly, s.exportChannel)
	s.route(mux, "POST /api/channels/import", engineerOnly, s.importChannel)
	s.route(mux, "GET /api/channels/{channelID}/frames", operatorOnly, s.channelFrames)
	s.route(mux, "GET /api/system/config-backup", adminOnly, s.configBackup)
	s.route(mux, "POST /api/system/config-restore", adminOnly, s.configRestore)
	s.route(mux, "POST /api/system/factory-reset", adminOnly, s.factoryReset)
	s.route(mux, "GET /api/system/diag", adminOnly, s.systemDiag)
	s.route(mux, "GET /api/system/openapi.json", operatorOnly, s.openAPIDoc)
	s.route(mux, "POST /api/scheduler/rebalance", engineerOnly, s.rebalanceScheduler)
	s.route(mux, "GET /ws", public, s.websocketHandler)
	return s.withClientAllowlist(withWeb(s.withCORS(mux), s.web))
}

func (s *Server) login(w http.ResponseWriter, r *http.Request) {
	if s.users == nil {
		writeJSON(w, http.StatusNotImplemented, map[string]any{"ok": false, "error": "password login is not configured"})
		return
	}
	// 按客户端 IP 限速（账号级锁定另由用户库负责）。
	if s.rateLimited(r) {
		w.Header().Set("Retry-After", strconv.Itoa(int(s.failureWindow.Seconds())))
		writeJSON(w, http.StatusTooManyRequests, map[string]any{"ok": false, "error": "too many authentication failures"})
		return
	}
	var request struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}
	if err := json.NewDecoder(r.Body).Decode(&request); err != nil || request.Username == "" || request.Password == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": "username and password required"})
		return
	}
	token, p, err := s.users.Login(r.Context(), request.Username, request.Password, s.clientKey(r), r.UserAgent())
	if err != nil {
		s.recordAuthFailure(r)
		s.recordAudit(r, request.Username, "auth.login", "", map[string]any{"ok": false})
		message := "invalid credentials"
		if errors.Is(err, auth.ErrLocked) {
			message = "account temporarily locked"
		} else if !errors.Is(err, auth.ErrInvalidCredentials) {
			log.Printf("login: %v", err)
		}
		writeJSON(w, http.StatusUnauthorized, map[string]any{"ok": false, "error": message})
		return
	}
	s.clearAuthFailure(r)
	s.recordAudit(r, p.Username, "auth.login", "", map[string]any{"ok": true, "session": p.SessionID})
	writeJSON(w, http.StatusOK, map[string]any{
		"ok": true, "token": token, "username": p.Username, "role": p.Role,
		"user":               map[string]any{"id": p.UserID, "username": p.Username, "role": p.Role},
		"mustChangePassword": p.MustChangePassword,
	})
}

func (s *Server) me(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	writeJSON(w, http.StatusOK, map[string]any{"id": p.UserID, "username": p.Username, "role": p.Role, "mustChangePassword": p.MustChangePassword, "devMode": s.devMode})
}

func (s *Server) logout(w http.ResponseWriter, r *http.Request) {
	if s.users != nil {
		s.users.Logout(r.Context(), bearerToken(r))
	}
	s.recordAudit(r, actor(r), "auth.logout", "", nil)
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (s *Server) changePassword(w http.ResponseWriter, r *http.Request) {
	if s.users == nil || principal(r).UserID == "" || s.devNoAuth {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": "password change requires a user session"})
		return
	}
	var request struct {
		CurrentPassword string `json:"currentPassword"`
		OldPassword     string `json:"oldPassword"`
		NewPassword     string `json:"newPassword"`
	}
	if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": "invalid JSON body"})
		return
	}
	current := request.CurrentPassword
	if current == "" {
		current = request.OldPassword
	}
	if err := s.users.ChangeOwnPassword(r.Context(), bearerToken(r), current, request.NewPassword); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	s.recordAudit(r, actor(r), "auth.password.change", principal(r).UserID, nil)
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// originAllowed 判断浏览器来源是否可信：无 Origin（非浏览器客户端）、与本服务同源、
// 或在 CORS 白名单中。用于拒绝跨站写请求（CSRF）和跨站 WebSocket 握手。
func (s *Server) originAllowed(r *http.Request) bool {
	origin := r.Header.Get("Origin")
	if origin == "" {
		return true
	}
	if _, ok := s.cors[origin]; ok {
		return true
	}
	u, err := url.Parse(origin)
	if err != nil || u.Host == "" {
		return false // 包括 "null" 来源（沙箱 iframe、file://）
	}
	if s.devMode && u.Scheme == "http" && (u.Hostname() == "localhost" || u.Hostname() == "127.0.0.1") {
		return true
	}
	return strings.EqualFold(u.Host, r.Host)
}

func isSafeMethod(method string) bool {
	return method == http.MethodGet || method == http.MethodHead || method == http.MethodOptions
}

// hasJSONBody 检查带请求体的写请求是否声明为 JSON。浏览器跨站"简单请求"只能发
// text/plain、表单等类型，不经预检；强制 application/json 可让这类请求无法到达处理函数。
func hasJSONBody(r *http.Request) bool {
	if r.ContentLength == 0 && len(r.TransferEncoding) == 0 {
		return true // 无请求体，如 logout、连接测试
	}
	mediaType, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	return err == nil && mediaType == "application/json"
}

func (s *Server) withCORS(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Body != nil {
			r.Body = http.MaxBytesReader(w, r.Body, maxRequestBodyBytes)
		}
		if !isSafeMethod(r.Method) {
			if !s.originAllowed(r) {
				writeJSON(w, http.StatusForbidden, map[string]any{"ok": false, "error": "origin not allowed"})
				return
			}
			if !hasJSONBody(r) {
				writeJSON(w, http.StatusUnsupportedMediaType, map[string]any{"ok": false, "error": "content-type must be application/json"})
				return
			}
		}
		origin := r.Header.Get("Origin")
		_, allowed := s.cors[origin]
		if !allowed && origin != "" && s.devMode {
			allowed = s.originAllowed(r)
		}
		if origin != "" {
			if !allowed {
				if r.Method == http.MethodOptions {
					writeJSON(w, http.StatusForbidden, map[string]any{"ok": false, "error": "origin not allowed"})
					return
				}
			} else {
				w.Header().Set("Access-Control-Allow-Origin", origin)
				w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
				w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
				w.Header().Add("Vary", "Origin")
			}
		}
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (s *Server) health(w http.ResponseWriter, _ *http.Request) {
	storageStatus := map[string]any{"engine": "tdengine", "state": "disabled", "queued": 0, "written": 0, "dropped": 0}
	if s.storage != nil {
		storageStatus = map[string]any{"engine": s.storage.Status().Engine, "state": s.storage.Status().State, "queued": s.storage.Status().Queued, "written": s.storage.Status().Written, "dropped": s.storage.Status().Dropped, "error": s.storage.Status().Error}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":        true,
		"uptimeSec": int(time.Since(s.startedAt).Seconds()),
		"channels":  len(s.cfg().Channels),
		"tags":      len(s.cfg().Tags),
		"storage":   storageStatus,
	})
}

func (s *Server) metrics(w http.ResponseWriter, r *http.Request) {
	metrics := s.engine.Metrics()
	writeJSON(w, http.StatusOK, map[string]any{
		"uptimeSec":   int(time.Since(s.startedAt).Seconds()),
		"acquisition": metrics,
		"storage": func() map[string]any {
			if s.storage == nil {
				return map[string]any{"state": "disabled", "queued": 0, "written": 0, "dropped": 0}
			}
			status := s.storage.Status()
			return map[string]any{"state": status.State, "queued": status.Queued, "written": status.Written, "dropped": status.Dropped, "error": status.Error}
		}(),
	})
}

func (s *Server) prometheusMetrics(w http.ResponseWriter, _ *http.Request) {
	acquisitionMetrics := s.engine.Metrics()
	storageQueued, storageWritten, storageDropped := 0, 0, 0
	if s.storage != nil {
		status := s.storage.Status()
		storageQueued, storageWritten, storageDropped = status.Queued, status.Written, status.Dropped
	}
	w.Header().Set("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
	f := func(format string, args ...any) { _, _ = fmt.Fprintf(w, format, args...) }
	f("# HELP factorybridge_acquisition_samples_total Samples published by acquisition drivers.\n# TYPE factorybridge_acquisition_samples_total counter\nfactorybridge_acquisition_samples_total %d\n", acquisitionMetrics.SamplesTotal)
	f("# HELP factorybridge_acquisition_status_updates_total Channel status updates received.\n# TYPE factorybridge_acquisition_status_updates_total counter\nfactorybridge_acquisition_status_updates_total %d\n", acquisitionMetrics.StatusUpdates)
	f("# HELP factorybridge_acquisition_channels Current channel count by state.\n# TYPE factorybridge_acquisition_channels gauge\n")
	f("factorybridge_acquisition_channels{state=\"online\"} %d\n", acquisitionMetrics.Online)
	f("factorybridge_acquisition_channels{state=\"offline\"} %d\n", acquisitionMetrics.Offline)
	f("factorybridge_acquisition_channels{state=\"connecting\"} %d\n", acquisitionMetrics.Connecting)
	f("factorybridge_acquisition_channels{state=\"disabled\"} %d\n", acquisitionMetrics.Disabled)
	f("factorybridge_acquisition_channels{state=\"error\"} %d\n", acquisitionMetrics.Error)
	f("factorybridge_acquisition_channels{state=\"unknown\"} %d\n", acquisitionMetrics.Unknown)
	f("# HELP factorybridge_acquisition_offline_transitions_total Offline transitions observed.\n# TYPE factorybridge_acquisition_offline_transitions_total counter\nfactorybridge_acquisition_offline_transitions_total %d\n", acquisitionMetrics.OfflineTransitions)
	f("# HELP factorybridge_acquisition_recoveries_total Offline to online recoveries observed.\n# TYPE factorybridge_acquisition_recoveries_total counter\nfactorybridge_acquisition_recoveries_total %d\n", acquisitionMetrics.Recoveries)
	f("# HELP factorybridge_acquisition_reconnects_total Reconnect recoveries observed after an offline state.\n# TYPE factorybridge_acquisition_reconnects_total counter\nfactorybridge_acquisition_reconnects_total %d\n", acquisitionMetrics.Recoveries)
	f("# HELP factorybridge_acquisition_latency_ms_total Sum of successful acquisition latency in milliseconds.\n# TYPE factorybridge_acquisition_latency_ms_total counter\nfactorybridge_acquisition_latency_ms_total %d\n", acquisitionMetrics.LatencyTotalMs)
	f("# HELP factorybridge_acquisition_latency_samples_total Successful acquisition latency samples.\n# TYPE factorybridge_acquisition_latency_samples_total counter\nfactorybridge_acquisition_latency_samples_total %d\n", acquisitionMetrics.LatencySamples)
	f("# HELP factorybridge_acquisition_last_latency_ms Last successful acquisition latency in milliseconds.\n# TYPE factorybridge_acquisition_last_latency_ms gauge\nfactorybridge_acquisition_last_latency_ms %d\n", acquisitionMetrics.LastLatencyMs)
	f("# HELP factorybridge_storage_queue_items Current storage queue size.\n# TYPE factorybridge_storage_queue_items gauge\nfactorybridge_storage_queue_items %d\n", storageQueued)
	f("# HELP factorybridge_storage_written_total Storage writes completed.\n# TYPE factorybridge_storage_written_total counter\nfactorybridge_storage_written_total %d\n", storageWritten)
	f("# HELP factorybridge_storage_dropped_total Storage items dropped.\n# TYPE factorybridge_storage_dropped_total counter\nfactorybridge_storage_dropped_total %d\n", storageDropped)
}

func (s *Server) channels(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, s.engine.Statuses())
}

func (s *Server) tags(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, s.cfg().Tags)
}

func (s *Server) fullConfig(w http.ResponseWriter, r *http.Request) {
	current := s.cfg()
	if current.Raw != nil {
		writeJSON(w, http.StatusOK, redactSecrets(current.Raw))
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"channels": current.Channels, "tags": current.Tags})
}

func (s *Server) createChannel(w http.ResponseWriter, r *http.Request) {
	var channel domain.Channel
	if err := json.NewDecoder(r.Body).Decode(&channel); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid channel JSON"})
		return
	}
	channel.ID = "channel-" + strconv.FormatInt(time.Now().UnixNano(), 10)
	if channel.Name == "" || channel.Protocol == "" || channel.Port < 1 || channel.Port > 65535 {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "name, protocol and valid port are required"})
		return
	}
	if channel.Params == nil {
		channel.Params = map[string]any{}
	}
	s.configMu.Lock()
	if err := s.persistConfigLocked(func(cfg *config.Config) { cfg.Channels = append(cfg.Channels, channel) }); err != nil {
		s.configMu.Unlock()
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": err.Error()})
		return
	}
	s.configMu.Unlock()
	writeJSON(w, http.StatusCreated, channel)
}

func (s *Server) updateChannel(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("channelID")
	var patch map[string]any
	if err := json.NewDecoder(r.Body).Decode(&patch); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid channel JSON"})
		return
	}
	// GET /api/config 返回的通道参数里口令已被清空（B4），界面原样回传时不能覆盖已存的值。
	preserveSecrets(patch)
	s.configMu.Lock()
	var result domain.Channel
	found := false
	err := s.persistConfigLocked(func(cfg *config.Config) {
		for i := range cfg.Channels {
			if cfg.Channels[i].ID == id {
				encoded, _ := json.Marshal(patch)
				_ = json.Unmarshal(encoded, &cfg.Channels[i])
				result = cfg.Channels[i]
				found = true
				break
			}
		}
	})
	s.configMu.Unlock()
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": err.Error()})
		return
	}
	if !found {
		writeJSON(w, http.StatusNotFound, map[string]any{"error": "channel not found"})
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (s *Server) getChannelDriver(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("channelID")
	s.configMu.RLock()
	defer s.configMu.RUnlock()
	for _, channel := range s.cfg().Channels {
		if channel.ID == id {
			driver := "auto"
			if channel.Params != nil {
				if value, ok := channel.Params["driver"].(string); ok && value != "" {
					driver = value
				}
			}
			writeJSON(w, http.StatusOK, map[string]any{"channelId": id, "protocol": channel.Protocol, "driver": driver})
			return
		}
	}
	writeJSON(w, http.StatusNotFound, map[string]any{"error": "channel not found"})
}

func (s *Server) updateChannelDriver(w http.ResponseWriter, r *http.Request) {
	var request struct {
		Driver string `json:"driver"`
	}
	if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid driver JSON"})
		return
	}
	request.Driver = strings.ToLower(strings.TrimSpace(request.Driver))
	if request.Driver != "auto" && request.Driver != "go" && request.Driver != "node" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "driver must be auto, go or node"})
		return
	}
	id := r.PathValue("channelID")
	s.configMu.Lock()
	var result map[string]any
	found := false
	err := s.persistConfigLocked(func(cfg *config.Config) {
		for i := range cfg.Channels {
			channel := &cfg.Channels[i]
			if channel.ID != id {
				continue
			}
			found = true
			if channel.Params == nil {
				channel.Params = map[string]any{}
			}
			switch request.Driver {
			case "go":
				driver, ok := goDriverForProtocol(channel.Protocol)
				if !ok {
					return
				}
				channel.Params["driver"] = driver
			case "node":
				channel.Params["driver"] = "node"
			default:
				delete(channel.Params, "driver")
			}
			result = map[string]any{"channelId": id, "protocol": channel.Protocol, "driver": request.Driver, "params": channel.Params}
			break
		}
	})
	s.configMu.Unlock()
	if !found {
		writeJSON(w, http.StatusNotFound, map[string]any{"error": "channel not found"})
		return
	}
	if request.Driver == "go" && result == nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "protocol has no Go driver"})
		return
	}
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func goDriverForProtocol(protocol string) (string, bool) {
	driver, ok := map[string]string{
		"Modbus TCP": "modbus-go", "Siemens Profinet": "s7-go",
		"Mitsubishi MELSEC": "melsec-go", "Omron FINS": "fins-go",
		"EtherNet/IP (Rockwell)": "enip-go", "SNMP": "snmp-go",
		"OPC UA": "opcua-go", "BACnet/IP": "bacnet-go",
	}[protocol]
	return driver, ok
}

func (s *Server) deleteChannel(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("channelID")
	s.configMu.Lock()
	found := false
	err := s.persistConfigLocked(func(cfg *config.Config) {
		for i := range cfg.Channels {
			if cfg.Channels[i].ID == id {
				cfg.Channels = append(cfg.Channels[:i], cfg.Channels[i+1:]...)
				filtered := cfg.Tags[:0]
				for _, tag := range cfg.Tags {
					if tag.ChannelID != id {
						filtered = append(filtered, tag)
					}
				}
				cfg.Tags = filtered
				found = true
				break
			}
		}
	})
	s.configMu.Unlock()
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": err.Error()})
		return
	}
	if !found {
		writeJSON(w, http.StatusNotFound, map[string]any{"error": "channel not found"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (s *Server) createTag(w http.ResponseWriter, r *http.Request) {
	var tag domain.Tag
	if err := json.NewDecoder(r.Body).Decode(&tag); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid tag JSON"})
		return
	}
	tag.ID = "tag-" + strconv.FormatInt(time.Now().UnixNano(), 10)
	if tag.ChannelID == "" || tag.Name == "" || tag.Address == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "channelId, name and address are required"})
		return
	}
	s.configMu.Lock()
	foundChannel := false
	err := s.persistConfigLocked(func(cfg *config.Config) {
		for _, channel := range cfg.Channels {
			if channel.ID == tag.ChannelID {
				foundChannel = true
				break
			}
		}
		if foundChannel {
			cfg.Tags = append(cfg.Tags, tag)
		}
	})
	s.configMu.Unlock()
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": err.Error()})
		return
	}
	if !foundChannel {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "channel not found"})
		return
	}
	writeJSON(w, http.StatusCreated, tag)
}

func (s *Server) updateTag(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("tagID")
	var patch map[string]any
	if err := json.NewDecoder(r.Body).Decode(&patch); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid tag JSON"})
		return
	}
	s.configMu.Lock()
	var result domain.Tag
	found := false
	err := s.persistConfigLocked(func(cfg *config.Config) {
		for i := range cfg.Tags {
			if cfg.Tags[i].ID == id {
				encoded, _ := json.Marshal(patch)
				_ = json.Unmarshal(encoded, &cfg.Tags[i])
				result = cfg.Tags[i]
				found = true
				break
			}
		}
	})
	s.configMu.Unlock()
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": err.Error()})
		return
	}
	if !found {
		writeJSON(w, http.StatusNotFound, map[string]any{"error": "tag not found"})
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (s *Server) deleteTag(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("tagID")
	s.configMu.Lock()
	found := false
	err := s.persistConfigLocked(func(cfg *config.Config) {
		for i := range cfg.Tags {
			if cfg.Tags[i].ID == id {
				cfg.Tags = append(cfg.Tags[:i], cfg.Tags[i+1:]...)
				found = true
				break
			}
		}
	})
	s.configMu.Unlock()
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": err.Error()})
		return
	}
	if !found {
		writeJSON(w, http.StatusNotFound, map[string]any{"error": "tag not found"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (s *Server) testChannel(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("channelID")
	for _, status := range s.engine.Statuses() {
		if status.ID == id {
			writeJSON(w, http.StatusOK, map[string]any{"ok": status.State == "online", "channelId": id, "state": status.State, "detail": status.Detail})
			return
		}
	}
	writeJSON(w, http.StatusNotFound, map[string]any{"ok": false, "error": "channel not found"})
}

// cfg 返回当前已发布的配置。返回值只读：不得修改其中的切片或 map，
// 修改一律经 commitConfigLocked。读取方不需要持有 configMu。
func (s *Server) cfg() *config.Config { return s.cfgPtr.Load() }

// commitConfigLocked 以写时复制方式修改配置：复制当前版本、在副本上修改、保存，
// 保存成功后才发布。调用方须持有 configMu，以串行化并发写入。
// 保存失败时内存中的配置保持原样，不会出现"已改内存、未落盘"的状态。
func (s *Server) commitConfigLocked(update func(*config.Config)) (*config.Config, error) {
	next := s.cfg().Clone()
	if next.Raw == nil {
		next.Raw = map[string]any{}
	}
	update(&next)
	if s.configStore != nil {
		if err := s.configStore.Save(next); err != nil {
			return s.cfg(), err
		}
	}
	s.cfgPtr.Store(&next)
	return &next, nil
}

// commitRawLocked 替换 Raw 中的一个顶层键并保存。调用方须持有 configMu。
func (s *Server) commitRawLocked(key string, value any) error {
	_, err := s.commitConfigLocked(func(c *config.Config) { c.Raw[key] = value })
	return err
}

func (s *Server) persistConfigLocked(update func(*config.Config)) error {
	next, err := s.commitConfigLocked(update)
	if err != nil {
		return err
	}
	if s.engine != nil {
		return s.engine.Reload(context.Background(), engineChannels(*next), engineTags(*next))
	}
	return nil
}

func engineChannels(cfg config.Config) []acquisition.Channel {
	channels := make([]acquisition.Channel, 0, len(cfg.Channels))
	for _, channel := range cfg.Channels {
		channels = append(channels, acquisition.Channel{ID: channel.ID, Protocol: channel.Protocol, Host: channel.Host, Port: channel.Port, Enabled: channel.Enabled, PollIntervalMs: channel.PollIntervalMs, Params: channel.Params})
	}
	return channels
}

func engineTags(cfg config.Config) []acquisition.Tag {
	tags := make([]acquisition.Tag, 0, len(cfg.Tags))
	for _, tag := range cfg.Tags {
		tags = append(tags, acquisition.Tag{ID: tag.ID, ChannelID: tag.ChannelID, Name: tag.Name, Address: tag.Address, DataType: tag.DataType, Scale: tag.Scale, Offset: tag.Offset})
	}
	return tags
}

func (s *Server) scheduler(w http.ResponseWriter, r *http.Request) {
	statuses := s.engine.Statuses()
	online := 0
	for _, status := range statuses {
		if status.State == "online" {
			online++
		}
	}
	channels := make([]map[string]any, 0, len(s.cfg().Channels))
	for _, channel := range s.cfg().Channels {
		state := "disabled"
		for _, status := range statuses {
			if status.ID == channel.ID {
				state = status.State
				break
			}
		}
		tagCount := 0
		for _, tag := range s.cfg().Tags {
			if tag.ChannelID == channel.ID {
				tagCount++
			}
		}
		channels = append(channels, map[string]any{
			"id": channel.ID, "name": channel.Name, "protocol": channel.Protocol,
			"enabled": channel.Enabled, "state": state, "pollIntervalMs": channel.PollIntervalMs,
			"tags": tagCount, "samples": 0, "rateHz": 0, "tx": 0, "rx": 0, "err": 0,
			"timeoutRate": 0, "avgCycleMs": 0,
		})
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"uptimeSec": int(time.Since(s.startedAt).Seconds()), "totalSamples": 0, "rateHz": 0,
		"onlineChannels": online, "avgCycleMs": 0, "channels": channels,
	})
}

func (s *Server) liveTags(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, wireSamples(s.engine.Snapshot()))
}

func (s *Server) writeTag(w http.ResponseWriter, r *http.Request) {
	var request struct {
		Value json.RawMessage `json:"value"`
	}
	decoder := json.NewDecoder(r.Body)
	if err := decoder.Decode(&request); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": "invalid JSON body"})
		return
	}
	value, err := decodeWriteValue(request.Value)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": err.Error()})
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	if err := s.engine.Write(ctx, r.PathValue("tagID"), value); err != nil {
		s.recordWrite(r, r.PathValue("tagID"), value, err)
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	s.recordWrite(r, r.PathValue("tagID"), value, nil)
	s.shadowStore.SetDesired(r.PathValue("tagID"), wireValue(value), actor(r))
	s.scheduleShadowPublish()
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (s *Server) clientKey(r *http.Request) string {
	if host, _, err := net.SplitHostPort(r.RemoteAddr); err == nil {
		return host
	}
	if r.RemoteAddr == "" {
		return "unknown"
	}
	return r.RemoteAddr
}

const maxTrackedFailureClients = 4096

// maxRequestBodyBytes 是普通 API 请求体上限。脚本接口自身另有 256 KiB 限制，
// 配置导入、配方等最大的合法请求也远小于 1 MiB。
const maxRequestBodyBytes = 1 << 20

func (s *Server) rateLimited(r *http.Request) bool {
	key := s.clientKey(r)
	s.limiterMu.Lock()
	defer s.limiterMu.Unlock()
	failure, ok := s.failures[key]
	return ok && time.Since(failure.started) < s.failureWindow && failure.count >= s.failureLimit
}

func (s *Server) recordAuthFailure(r *http.Request) {
	key := s.clientKey(r)
	s.limiterMu.Lock()
	defer s.limiterMu.Unlock()
	failure := s.failures[key]
	if failure.started.IsZero() || time.Since(failure.started) >= s.failureWindow {
		failure = authFailure{started: time.Now()}
	}
	// 失败计数表按来源 IP 增长，超过上限时清掉已过窗口的条目，防止被随机来源撑大。
	if len(s.failures) >= maxTrackedFailureClients {
		for k, v := range s.failures {
			if time.Since(v.started) >= s.failureWindow {
				delete(s.failures, k)
			}
		}
	}
	failure.count++
	s.failures[key] = failure
}

func (s *Server) clearAuthFailure(r *http.Request) {
	s.limiterMu.Lock()
	delete(s.failures, s.clientKey(r))
	s.limiterMu.Unlock()
}

func (s *Server) recordWrite(r *http.Request, tagID string, value acquisition.Value, writeErr error) {
	s.recordWriteBy(actor(r), tagID, value, writeErr)
}

// recordAudit 写一条审计事件；失败只记日志，不影响业务结果。
func (s *Server) recordAudit(r *http.Request, who, action, target string, detail map[string]any) {
	if s.audit == nil {
		return
	}
	if detail == nil {
		detail = map[string]any{}
	}
	detail["ip"] = s.clientKey(r)
	if err := s.audit.Record(audit.Event{Actor: who, Action: action, Target: target, Detail: detail}); err != nil {
		log.Printf("audit write failed: %v", err)
	}
}

func (s *Server) recordWriteBy(who, tagID string, value acquisition.Value, writeErr error) {
	if s.audit == nil {
		return
	}
	detail := map[string]any{"value": value}
	if writeErr != nil {
		detail["error"] = writeErr.Error()
	}
	if err := s.audit.Record(audit.Event{
		Actor:  who,
		Action: "tag.write",
		Target: tagID,
		Detail: detail,
	}); err != nil {
		// A failed audit write must be visible to the caller's logs, but should
		// not turn a successful device write into a false device failure.
		log.Printf("audit write failed: %v", err)
	}
}

func decodeWriteValue(raw json.RawMessage) (acquisition.Value, error) {
	if len(bytes.TrimSpace(raw)) == 0 || bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return acquisition.Value{}, fmt.Errorf("body.value required")
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	var value any
	if err := decoder.Decode(&value); err != nil {
		return acquisition.Value{}, fmt.Errorf("invalid body.value")
	}
	switch value := value.(type) {
	case json.Number:
		number, err := value.Float64()
		if err != nil {
			return acquisition.Value{}, fmt.Errorf("body.value must be a finite number")
		}
		return acquisition.NumberValue(number), nil
	case bool:
		return acquisition.BoolValue(value), nil
	case string:
		return acquisition.StringValue(value), nil
	default:
		return acquisition.Value{}, fmt.Errorf("body.value must be a number, string, or boolean")
	}
}

func (s *Server) systemInfo(w http.ResponseWriter, r *http.Request) {
	storageStatus := storage.Status{Engine: "tdengine", State: "disabled"}
	storageURL, storageDB := "", ""
	if s.storage != nil {
		storageStatus = s.storage.Status()
		storageURL, storageDB = s.storage.ConfigSummary()
		storageURL = redactURLCredentials(storageURL)
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"name":          "FactoryBridge Go Gateway",
		"version":       version.Version,
		"devMode":       s.devMode,
		"devNoAuth":     s.devNoAuth,
		"build":         version.Info(),
		"startedAt":     s.startedAt,
		"uptimeSec":     int(time.Since(s.startedAt).Seconds()),
		"goVersion":     runtime.Version(),
		"platform":      runtime.GOOS + "/" + runtime.GOARCH,
		"channels":      len(s.cfg().Channels),
		"tags":          len(s.cfg().Tags),
		"schemaVersion": s.cfg().SchemaVersion,
		"storage":       map[string]any{"url": storageURL, "db": storageDB, "state": storageStatus.State, "queued": storageStatus.Queued, "written": storageStatus.Written, "dropped": storageStatus.Dropped},
		"counts":        map[string]any{"channels": len(s.cfg().Channels), "tags": len(s.cfg().Tags), "alarms": len(s.alarms.rulesSnapshot()), "storageTasks": len(s.storageTasksSnapshot()), "recipes": 0, "scripts": 0},
	})
}

func (s *Server) dbTest(w http.ResponseWriter, r *http.Request) {
	if s.storage == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{"ok": false, "error": "storage is not configured"})
		return
	}
	started := time.Now()
	err := s.storage.Ping(r.Context())
	result := map[string]any{"ok": err == nil, "latencyMs": time.Since(started).Milliseconds()}
	if err != nil {
		result["error"] = err.Error()
		writeJSON(w, http.StatusServiceUnavailable, result)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (s *Server) dbInit(w http.ResponseWriter, r *http.Request) {
	if s.storage == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{"ok": false, "error": "storage is not configured"})
		return
	}
	if err := s.storage.Init(r.Context()); err != nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("content-type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

// Close 释放服务器持有的资源（静态文件目录句柄）。
func (s *Server) Close() error {
	if s.closeWeb != nil {
		return s.closeWeb()
	}
	return nil
}

// WebEnabled 报告是否在托管控制台页面。
func (s *Server) WebEnabled() bool { return s.web != nil }

// withClientAllowlist 按 TCP 对端地址判断，不信任 X-Forwarded-For（网关前没有可信代理时该头可伪造）。
func (s *Server) withClientAllowlist(next http.Handler) http.Handler {
	if len(s.allowedClients) == 0 {
		return next
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		addr, err := netip.ParseAddr(s.clientKey(r))
		allowed := false
		if err == nil {
			addr = addr.Unmap()
			for _, prefix := range s.allowedClients {
				if prefix.Contains(addr) {
					allowed = true
					break
				}
			}
		}
		if !allowed {
			writeJSON(w, http.StatusForbidden, map[string]any{"ok": false, "error": "client address not allowed"})
			return
		}
		next.ServeHTTP(w, r)
	})
}
