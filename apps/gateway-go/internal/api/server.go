package api

import (
	"bytes"
	"context"
	"crypto/subtle"
	"encoding/json"
	"fmt"
	"log"
	"mime"
	"net"
	"net/http"
	"net/url"
	"reflect"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/factorybridge/iotconnector/gateway-go/internal/acquisition"
	"github.com/factorybridge/iotconnector/gateway-go/internal/audit"
	"github.com/factorybridge/iotconnector/gateway-go/internal/auth"
	"github.com/factorybridge/iotconnector/gateway-go/internal/config"
	"github.com/factorybridge/iotconnector/gateway-go/internal/domain"
	"github.com/factorybridge/iotconnector/gateway-go/internal/northbound"
	"github.com/factorybridge/iotconnector/gateway-go/internal/shadow"
	"github.com/factorybridge/iotconnector/gateway-go/internal/storage"
	"golang.org/x/crypto/bcrypt"
)

type Server struct {
	startedAt           time.Time
	config              config.Config
	engine              *acquisition.Engine
	credentials         map[string]Role
	sessions            *auth.Manager
	passwordStore       *auth.PasswordStore
	loginUsername       string
	loginPassword       string
	loginHash           string
	audit               *audit.Logger
	cors                map[string]struct{}
	limiterMu           sync.Mutex
	failures            map[string]authFailure
	failureLimit        int
	failureWindow       time.Duration
	ws                  *wsHub
	configStore         *config.Store
	configMu            sync.RWMutex
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
	Token              string // Backward-compatible operator token.
	ViewerToken        string
	OperatorToken      string
	AdminToken         string
	LoginUsername      string
	LoginPassword      string
	LoginPasswordHash  string
	PasswordFile       string
	MustChangePassword bool
	SessionTTL         time.Duration
	SessionFile        string
	HistoryFile        string
	Audit              *audit.Logger
	ConfigStore        *config.Store
	Storage            *storage.Writer
	ShadowFile         string
	CORSOrigins        []string
	FailureLimit       int
	FailureWindow      time.Duration
}

type Role string

const (
	RoleViewer   Role = "viewer"
	RoleOperator Role = "operator"
	RoleAdmin    Role = "admin"
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
	if options.LoginUsername == "" {
		options.LoginUsername = "admin"
	}
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
	passwordStore, err := auth.OpenPasswordStore(options.PasswordFile, options.LoginUsername, options.LoginPassword, options.LoginPasswordHash, options.MustChangePassword)
	if err != nil {
		log.Printf("password store unavailable: %v", err)
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
	server := &Server{
		startedAt: time.Now(), config: cfg, engine: engine, credentials: credentials, audit: options.Audit,
		sessions: auth.NewManager(options.SessionTTL, options.SessionFile), passwordStore: passwordStore, loginUsername: options.LoginUsername, loginPassword: options.LoginPassword, loginHash: options.LoginPasswordHash,
		cors: origins, failures: make(map[string]authFailure),
		failureLimit: options.FailureLimit, failureWindow: options.FailureWindow,
		configStore:  options.ConfigStore,
		historyStore: newHistoryStore(options.HistoryFile),
		alarms:       newAlarmManager(cfg.Raw["alarms"]),
		storage:      options.Storage,
		shadowStore:  shadow.New(options.ShadowFile, nil),
	}
	server.ws = newWSHub()
	engine.SetOnSample(func(sample acquisition.Sample) {
		server.historyStore.add(sample)
		if server.storage != nil {
			for _, tag := range server.config.Tags {
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
		for _, tag := range server.config.Tags {
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
	for _, tag := range s.config.Tags {
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
		for _, tag := range s.config.Tags {
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
	mux.HandleFunc("GET /metrics", s.prometheusMetrics)
	mux.HandleFunc("GET /api/health", s.health)
	mux.HandleFunc("GET /api/metrics", s.metrics)
	mux.HandleFunc("GET /api/system/info", s.systemInfo)
	mux.HandleFunc("POST /api/system/db-test", s.dbTest)
	mux.HandleFunc("POST /api/system/db-init", s.dbInit)
	mux.HandleFunc("GET /api/channels", s.channels)
	mux.HandleFunc("POST /api/channels", s.createChannel)
	mux.HandleFunc("PUT /api/channels/{channelID}", s.updateChannel)
	mux.HandleFunc("GET /api/channels/{channelID}/driver", s.getChannelDriver)
	mux.HandleFunc("PUT /api/channels/{channelID}/driver", s.updateChannelDriver)
	mux.HandleFunc("DELETE /api/channels/{channelID}", s.deleteChannel)
	mux.HandleFunc("POST /api/channels/{channelID}/test", s.testChannel)
	mux.HandleFunc("GET /api/tags", s.tags)
	mux.HandleFunc("POST /api/tags", s.createTag)
	mux.HandleFunc("PUT /api/tags/{tagID}", s.updateTag)
	mux.HandleFunc("DELETE /api/tags/{tagID}", s.deleteTag)
	mux.HandleFunc("GET /api/config", s.fullConfig)
	mux.HandleFunc("GET /api/scheduler", s.scheduler)
	mux.HandleFunc("GET /api/alarms", s.alarmResponse)
	mux.HandleFunc("POST /api/alarms", s.createAlarm)
	mux.HandleFunc("PUT /api/alarms/{alarmID}", s.updateAlarm)
	mux.HandleFunc("DELETE /api/alarms/{alarmID}", s.deleteAlarm)
	mux.HandleFunc("POST /api/alarms/events/{eventID}/ack", s.ackAlarm)
	mux.HandleFunc("GET /api/alarms/history", s.alarmHistory)
	mux.HandleFunc("GET /api/history", s.history)
	mux.HandleFunc("GET /api/storage-tasks", s.storageTasks)
	mux.HandleFunc("GET /api/storage-tasks/stats", s.storageTaskStats)
	mux.HandleFunc("POST /api/storage-tasks", s.createStorageTask)
	mux.HandleFunc("PUT /api/storage-tasks/{taskID}", s.updateStorageTask)
	mux.HandleFunc("DELETE /api/storage-tasks/{taskID}", s.deleteStorageTask)
	mux.HandleFunc("GET /api/notifications", s.notifications)
	mux.HandleFunc("PUT /api/notifications", s.updateNotifications)
	mux.HandleFunc("PUT /api/notifications/v2", s.updateNotifications)
	mux.HandleFunc("POST /api/notifications/test", s.testNotification)
	mux.HandleFunc("GET /api/recipes", s.recipes)
	mux.HandleFunc("POST /api/recipes", s.createRecipe)
	mux.HandleFunc("PUT /api/recipes/{recipeID}", s.updateRecipe)
	mux.HandleFunc("DELETE /api/recipes/{recipeID}", s.deleteRecipe)
	mux.HandleFunc("POST /api/recipes/{recipeID}/download", s.downloadRecipe)
	mux.HandleFunc("GET /api/recipes/downloads", s.recipeDownloads)
	mux.HandleFunc("POST /api/recipes/{recipeID}/duplicate", s.duplicateRecipe)
	mux.HandleFunc("GET /api/recipes/{recipeID}/export", s.exportRecipe)
	mux.HandleFunc("POST /api/recipes/import", s.importRecipe)
	mux.HandleFunc("GET /api/scripts", s.scriptsAPI)
	mux.HandleFunc("POST /api/scripts", s.createScript)
	mux.HandleFunc("PUT /api/scripts/{scriptID}", s.updateScript)
	mux.HandleFunc("DELETE /api/scripts/{scriptID}", s.deleteScript)
	mux.HandleFunc("POST /api/scripts/{scriptID}/run", s.runScript)
	mux.HandleFunc("GET /api/scripts/{scriptID}/output", s.scriptOutput)
	mux.HandleFunc("GET /api/shadow", s.shadow)
	mux.HandleFunc("GET /api/northbound", s.northbound)
	mux.HandleFunc("PUT /api/northbound", s.updateNorthbound)
	mux.HandleFunc("POST /api/northbound/rebirth", s.rebirthNorthbound)
	mux.HandleFunc("GET /api/tags/live", s.liveTags)
	mux.HandleFunc("POST /api/tags/{tagID}/write", s.writeTag)
	mux.HandleFunc("POST /api/auth/login", s.login)
	mux.HandleFunc("GET /api/auth/me", s.me)
	mux.HandleFunc("POST /api/auth/logout", s.logout)
	mux.HandleFunc("POST /api/auth/password", s.changePassword)
	mux.HandleFunc("POST /api/auth/change-password", s.changePassword)
	mux.HandleFunc("GET /ws", s.websocketHandler)
	return s.withCORS(mux)
}

func (s *Server) login(w http.ResponseWriter, r *http.Request) {
	if s.passwordStore == nil || !s.passwordStore.Enabled() {
		writeJSON(w, http.StatusNotImplemented, map[string]any{"ok": false, "error": "password login is not configured"})
		return
	}
	// 按客户端 IP 限速（不按用户名，避免他人用错误口令锁死 admin）。
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
	passwordOK := false
	mustChange := false
	if s.passwordStore != nil && s.passwordStore.Enabled() {
		passwordOK = s.passwordStore.Verify(request.Username, request.Password)
		mustChange = s.passwordStore.Record().MustChange
	} else if s.loginHash != "" {
		passwordOK = bcrypt.CompareHashAndPassword([]byte(s.loginHash), []byte(request.Password)) == nil
	} else {
		passwordOK = subtle.ConstantTimeCompare([]byte(request.Password), []byte(s.loginPassword)) == 1
	}
	if subtle.ConstantTimeCompare([]byte(request.Username), []byte(s.loginUsername)) != 1 || !passwordOK {
		s.recordAuthFailure(r)
		writeJSON(w, http.StatusUnauthorized, map[string]any{"ok": false, "error": "invalid credentials"})
		return
	}
	s.clearAuthFailure(r)
	token, session, err := s.sessions.CreateWithState(request.Username, auth.RoleAdmin, mustChange)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"ok": false, "error": "create session failed"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"ok": true, "token": token, "username": session.Username, "role": session.Role,
		"user":      map[string]any{"id": session.Username, "username": session.Username, "role": session.Role},
		"expiresAt": session.Expires, "mustChangePassword": session.MustChangePassword,
	})
}

func (s *Server) me(w http.ResponseWriter, r *http.Request) {
	role, ok, mustChange := s.authenticate(r)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, map[string]any{"ok": false, "error": "authentication required"})
		return
	}
	username := "token-user"
	const prefix = "Bearer "
	if authorization := r.Header.Get("Authorization"); strings.HasPrefix(authorization, prefix) {
		if session, found := s.sessions.Authenticate(strings.TrimPrefix(authorization, prefix)); found {
			username = session.Username
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"id": username, "username": username, "role": role, "mustChangePassword": mustChange})
}

func (s *Server) logout(w http.ResponseWriter, r *http.Request) {
	const prefix = "Bearer "
	authorization := r.Header.Get("Authorization")
	if len(authorization) > len(prefix) {
		s.sessions.Revoke(authorization[len(prefix):])
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (s *Server) changePassword(w http.ResponseWriter, r *http.Request) {
	const prefix = "Bearer "
	authorization := r.Header.Get("Authorization")
	if len(authorization) <= len(prefix) {
		writeJSON(w, http.StatusUnauthorized, map[string]any{"ok": false, "error": "session required"})
		return
	}
	token := authorization[len(prefix):]
	if _, ok := s.sessions.Authenticate(token); !ok || s.passwordStore == nil || !s.passwordStore.Enabled() {
		writeJSON(w, http.StatusUnauthorized, map[string]any{"ok": false, "error": "session required"})
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
	currentPassword := request.CurrentPassword
	if currentPassword == "" {
		currentPassword = request.OldPassword
	}
	if err := s.passwordStore.ChangePassword(currentPassword, request.NewPassword); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	s.sessions.MarkPasswordChanged(token)
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
		if origin != "" {
			if !allowed {
				if r.Method == http.MethodOptions {
					writeJSON(w, http.StatusForbidden, map[string]any{"ok": false, "error": "origin not allowed"})
					return
				}
			} else {
				w.Header().Set("Access-Control-Allow-Origin", origin)
				w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type, X-User")
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
		"channels":  len(s.config.Channels),
		"tags":      len(s.config.Tags),
		"storage":   storageStatus,
	})
}

func (s *Server) metrics(w http.ResponseWriter, r *http.Request) {
	if !s.authorize(w, r, RoleViewer) {
		return
	}
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
	if !s.authorize(w, r, RoleViewer) {
		return
	}
	writeJSON(w, http.StatusOK, s.engine.Statuses())
}

func (s *Server) tags(w http.ResponseWriter, r *http.Request) {
	if !s.authorize(w, r, RoleViewer) {
		return
	}
	writeJSON(w, http.StatusOK, s.config.Tags)
}

func (s *Server) fullConfig(w http.ResponseWriter, r *http.Request) {
	if !s.authorize(w, r, RoleViewer) {
		return
	}
	if s.config.Raw != nil {
		writeJSON(w, http.StatusOK, s.config.Raw)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"channels": s.config.Channels, "tags": s.config.Tags})
}

func (s *Server) createChannel(w http.ResponseWriter, r *http.Request) {
	if !s.authorize(w, r, RoleAdmin) {
		return
	}
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
	if !s.authorize(w, r, RoleAdmin) {
		return
	}
	id := r.PathValue("channelID")
	var patch map[string]any
	if err := json.NewDecoder(r.Body).Decode(&patch); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid channel JSON"})
		return
	}
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
	if !s.authorize(w, r, RoleViewer) {
		return
	}
	id := r.PathValue("channelID")
	s.configMu.RLock()
	defer s.configMu.RUnlock()
	for _, channel := range s.config.Channels {
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
	if !s.authorize(w, r, RoleAdmin) {
		return
	}
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
	if !s.authorize(w, r, RoleAdmin) {
		return
	}
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
	if !s.authorize(w, r, RoleAdmin) {
		return
	}
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
	if !s.authorize(w, r, RoleAdmin) {
		return
	}
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
	if !s.authorize(w, r, RoleAdmin) {
		return
	}
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
	if !s.authorize(w, r, RoleOperator) {
		return
	}
	id := r.PathValue("channelID")
	for _, status := range s.engine.Statuses() {
		if status.ID == id {
			writeJSON(w, http.StatusOK, map[string]any{"ok": status.State == "online", "channelId": id, "state": status.State, "detail": status.Detail})
			return
		}
	}
	writeJSON(w, http.StatusNotFound, map[string]any{"ok": false, "error": "channel not found"})
}

func (s *Server) persistConfigLocked(update func(*config.Config)) error {
	update(&s.config)
	if s.configStore != nil {
		if err := s.configStore.Save(s.config); err != nil {
			return err
		}
	}
	if s.engine != nil {
		return s.engine.Reload(context.Background(), engineChannels(s.config), engineTags(s.config))
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
	if !s.authorize(w, r, RoleViewer) {
		return
	}
	statuses := s.engine.Statuses()
	online := 0
	for _, status := range statuses {
		if status.State == "online" {
			online++
		}
	}
	channels := make([]map[string]any, 0, len(s.config.Channels))
	for _, channel := range s.config.Channels {
		state := "disabled"
		for _, status := range statuses {
			if status.ID == channel.ID {
				state = status.State
				break
			}
		}
		tagCount := 0
		for _, tag := range s.config.Tags {
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
	if !s.authorize(w, r, RoleViewer) {
		return
	}
	writeJSON(w, http.StatusOK, wireSamples(s.engine.Snapshot()))
}

func (s *Server) writeTag(w http.ResponseWriter, r *http.Request) {
	if !s.authorize(w, r, RoleOperator) {
		return
	}
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
	s.shadowStore.SetDesired(r.PathValue("tagID"), wireValue(value), r.Header.Get("X-User"))
	s.scheduleShadowPublish()
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (s *Server) authorize(w http.ResponseWriter, r *http.Request, required Role) bool {
	if len(s.credentials) == 0 && (s.passwordStore == nil || !s.passwordStore.Enabled()) {
		return true
	}
	if s.rateLimited(r) {
		w.Header().Set("Retry-After", "60")
		writeJSON(w, http.StatusTooManyRequests, map[string]any{"ok": false, "error": "too many authentication failures"})
		return false
	}
	role, ok, mustChange := s.authenticate(r)
	if !ok {
		s.recordAuthFailure(r)
		w.Header().Set("WWW-Authenticate", `Bearer realm="factorybridge"`)
		writeJSON(w, http.StatusUnauthorized, map[string]any{"ok": false, "error": "authentication required"})
		return false
	}
	if !roleAllows(role, required) {
		writeJSON(w, http.StatusForbidden, map[string]any{"ok": false, "error": "insufficient role"})
		return false
	}
	if mustChange && r.URL.Path != "/api/auth/password" {
		writeJSON(w, http.StatusForbidden, map[string]any{"ok": false, "error": "password change required"})
		return false
	}
	s.clearAuthFailure(r)
	return true
}

func (s *Server) authenticate(r *http.Request) (Role, bool, bool) {
	const prefix = "Bearer "
	authorization := r.Header.Get("Authorization")
	if len(authorization) <= len(prefix) || authorization[:len(prefix)] != prefix {
		return "", false, false
	}
	presented := authorization[len(prefix):]
	if session, ok := s.sessions.Authenticate(presented); ok {
		return Role(session.Role), true, session.MustChangePassword
	}
	for token, role := range s.credentials {
		if subtle.ConstantTimeCompare([]byte(presented), []byte(token)) == 1 {
			return role, true, false
		}
	}
	return "", false, false
}

func roleAllows(actual, required Role) bool {
	if actual == RoleAdmin {
		return true
	}
	if actual == required {
		return true
	}
	return actual == RoleOperator && required == RoleViewer
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
	if s.audit == nil {
		return
	}
	detail := map[string]any{"value": value}
	if writeErr != nil {
		detail["error"] = writeErr.Error()
	}
	if err := s.audit.Record(audit.Event{
		Actor:  r.Header.Get("X-User"),
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

func (s *Server) systemInfo(w http.ResponseWriter, _ *http.Request) {
	storageStatus := storage.Status{Engine: "tdengine", State: "disabled"}
	storageURL, storageDB := "", ""
	if s.storage != nil {
		storageStatus = s.storage.Status()
		storageURL, storageDB = s.storage.ConfigSummary()
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"name":          "FactoryBridge Go Gateway",
		"version":       "0.1.0-go-skeleton",
		"startedAt":     s.startedAt,
		"uptimeSec":     int(time.Since(s.startedAt).Seconds()),
		"goVersion":     runtime.Version(),
		"platform":      runtime.GOOS + "/" + runtime.GOARCH,
		"channels":      len(s.config.Channels),
		"tags":          len(s.config.Tags),
		"schemaVersion": s.config.SchemaVersion,
		"storage":       map[string]any{"url": storageURL, "db": storageDB, "state": storageStatus.State, "queued": storageStatus.Queued, "written": storageStatus.Written, "dropped": storageStatus.Dropped},
		"counts":        map[string]any{"channels": len(s.config.Channels), "tags": len(s.config.Tags), "alarms": len(s.alarms.rulesSnapshot()), "storageTasks": len(s.storageTasksSnapshot()), "recipes": 0, "scripts": 0},
	})
}

func (s *Server) dbTest(w http.ResponseWriter, r *http.Request) {
	if !s.authorize(w, r, RoleAdmin) {
		return
	}
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
	if !s.authorize(w, r, RoleAdmin) {
		return
	}
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
