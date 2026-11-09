package main

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/factorybridge/iotconnector/gateway-go/internal/acquisition"
	"github.com/factorybridge/iotconnector/gateway-go/internal/api"
	"github.com/factorybridge/iotconnector/gateway-go/internal/audit"
	"github.com/factorybridge/iotconnector/gateway-go/internal/config"
	"github.com/factorybridge/iotconnector/gateway-go/internal/db"
	"github.com/factorybridge/iotconnector/gateway-go/internal/northbound"
	"github.com/factorybridge/iotconnector/gateway-go/internal/storage"
	"github.com/factorybridge/iotconnector/gateway-go/internal/version"
)

// runGateway 是原 main 的主体，行为不变；路径和端口改由命令行参数传入（缺省仍读环境变量）。
func runGateway(opts runOptions) int {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	return runGatewayContext(ctx, opts)
}

// runGatewayContext 运行网关直到 ctx 结束。Windows 服务由 SCM 的停止请求取消 ctx。
func runGatewayContext(ctx context.Context, opts runOptions) int {
	logger := slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: opts.logLevel}))
	dataDir := opts.dataDir
	port := opts.port

	// 状态库最先打开：配置版本、outbox、历史、告警、审计、用户都依赖它（G1–G4、G6）。
	users, database, err := openUserStore(ctx, dataDir, os.Stdout)
	if err != nil {
		logger.Error("open state database", "error", err)
		return exitConfig
	}
	defer database.Close()
	// 采集配置以 gateway.db 中的最新版本为准，config.json 是镜像（G6）。
	store := config.NewStoreDB(dataDir, database)
	cfg, err := store.Load()
	if err != nil {
		logger.Error("load config", "error", err)
		return exitConfig
	}
	if store.ImportedEditedFile() {
		logger.Warn("config.json differs from the latest stored version (edited while stopped?); imported it as a new version", "file", store.Path)
	}
	engine := acquisition.NewEngine(toAcquisitionChannels(cfg), toAcquisitionTags(cfg), acquisition.NewFactory())
	if err := engine.Start(ctx); err != nil {
		logger.Error("start acquisition engine", "error", err)
		return exitError
	}
	stateBatch := db.NewBatch(database)
	// 批量写入有独立的生命周期：收到退出信号后，等 HTTP 与采集都停下（不再产生写入），
	// 再停止它，让最后一次提交包含关停期间的写入；之后才关库（defer database.Close）。
	batchCtx, stopBatch := context.WithCancel(context.Background())
	batchDone := make(chan struct{})
	go func() { stateBatch.Run(batchCtx, time.Second); close(batchDone) }()
	defer func() { stopBatch(); <-batchDone }()

	allowedClients, _ := parseCIDRs(opts.allowCIDR) // 已在 cmdRun 中校验
	var tlsConf *tls.Config
	scheme := "http"
	if !isLoopback(opts.host) || opts.tlsCert != "" {
		cert, source, selfSigned, err := loadOrCreateCert(opts.tlsCert, opts.tlsKey, dataDir, opts.host)
		if err != nil {
			logger.Error("load TLS certificate", "error", err)
			return exitConfig
		}
		tlsConf, scheme = tlsConfig(cert), "https"
		if selfSigned {
			logger.Warn("using a self-signed certificate; browsers will warn. Use --tls-cert/--tls-key with a CA-issued certificate in production", "cert", source)
		}
	}
	if !isLoopback(opts.host) && len(allowedClients) == 0 {
		logger.Warn("listening on a non-loopback address without --allow-cidr; any host that can reach this port can try to log in", "host", opts.host)
	}

	tdengineURL := setting("tdengineURL", "")
	tdenginePass, err := tdenginePassword()
	if err != nil {
		logger.Error(err.Error())
		return exitConfig
	}
	queueFile := ""
	if tdengineURL != "" {
		queueFile = filepath.Join(dataDir, "outbox.json")
	}
	storageWriter := storage.New(storage.Config{
		State: stateBatch, StateDB: database,
		URL: tdengineURL, User: setting("tdengineUser", "root"), Password: tdenginePass,
		Database: setting("tdengineDB", "factory_bridge"), SuperTable: setting("tdengineStable", "st_factory_equipment"),
		QueueFile: queueFile, AlarmQueueFile: func() string {
			if queueFile == "" {
				return ""
			}
			return filepath.Join(dataDir, "alarm-outbox.json")
		}(),
		MaxQueue: settingInt("outboxMax", 100000),
	})
	auditLogger := audit.NewDB(database, filepath.Join(dataDir, "audit.jsonl"))
	if opts.dev {
		if err := ensureDevAccount(ctx, users, opts.devPass, logger); err != nil {
			logger.Error("create dev account", "error", err)
			return exitConfig
		}
		logger.Warn("DEVELOPMENT MODE: loopback only, localhost origins allowed", "noAuth", opts.devNoAuth)
	} else if count, _ := users.CountUsers(ctx); count == 0 {
		logger.Warn("no users exist; create the first admin with: factorybridge user create --name <name> --role admin")
	}
	serverHandler := api.NewServerWithOptions(
		cfg,
		engine,
		api.SecurityOptions{
			Token:          setting("apiToken", ""),
			ViewerToken:    setting("viewerToken", ""),
			OperatorToken:  setting("operatorToken", ""),
			AdminToken:     setting("adminToken", ""),
			Users:          users,
			DevMode:        opts.dev,
			DevNoAuth:      opts.devNoAuth,
			WebDir:         opts.webDir,
			AllowedClients: allowedClients,
			StateDB:        database,
			State:          stateBatch,
			HistoryFile:    filepath.Join(dataDir, "history.jsonl"),
			Audit:          auditLogger,
			ConfigStore:    store,
			Storage:        storageWriter,
			ShadowFile:     filepath.Join(dataDir, "shadow.json"),
			CORSOrigins:    splitCSV(setting("corsOrigins", "")),
		},
	)
	northboundPublisher := northbound.NewDB(northbound.ConfigFromRaw(cfg.Raw["northbound"]), database, stateBatch, filepath.Join(dataDir, "northbound.json"), toAcquisitionChannels(cfg), toAcquisitionTags(cfg))
	northboundPublisher.OnCommand = func(name string, raw any) error {
		_ = auditLogger.Record(audit.Event{Actor: "mqtt", Action: "mqtt.cmd", Target: name, Detail: map[string]any{"value": raw}})
		// 按当前点表查找（C5）：启动后新增或改名的位号也能经 MQTT 下发。
		if tag, ok := northboundPublisher.TagByName(name); ok {
			switch value := raw.(type) {
			case float64:
				err := engine.Write(context.Background(), tag.ID, acquisition.NumberValue(value))
				if err == nil {
					serverHandler.SetShadowDesiredByName(name, raw, "mqtt")
				}
				return err
			case bool:
				err := engine.Write(context.Background(), tag.ID, acquisition.BoolValue(value))
				if err == nil {
					serverHandler.SetShadowDesiredByName(name, raw, "mqtt")
				}
				return err
			case string:
				err := engine.Write(context.Background(), tag.ID, acquisition.StringValue(value))
				if err == nil {
					serverHandler.SetShadowDesiredByName(name, raw, "mqtt")
				}
				return err
			default:
				return fmt.Errorf("unsupported MQTT command value")
			}
		}
		return fmt.Errorf("unknown MQTT command metric: %s", name)
	}
	defer serverHandler.Close()
	if serverHandler.WebEnabled() {
		logger.Info("serving console", "dir", opts.webDir)
	}
	serverHandler.AttachNorthbound(northboundPublisher)
	northboundPublisher.Start()
	// 每小时按保留期清理状态库（历史 7 天、告警 90 天、审计 365 天）
	go func() {
		ticker := time.NewTicker(time.Hour)
		defer ticker.Stop()
		for {
			serverHandler.PruneState(ctx)
			if err := auditLogger.Prune(ctx); err != nil && ctx.Err() == nil {
				logger.Warn("prune audit", "error", err)
			}
			select {
			case <-ticker.C:
			case <-ctx.Done():
				return
			}
		}
	}()
	go func() {
		ticker := time.NewTicker(time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				flushCtx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
				_ = storageWriter.Flush(flushCtx)
				cancel()
				serverHandler.BroadcastStorageStatus()
			case <-ctx.Done():
				return
			}
		}
	}()

	server := &http.Server{
		Addr:              net.JoinHostPort(opts.host, strconv.Itoa(port)),
		Handler:           serverHandler.Handler(),
		ReadHeaderTimeout: 5 * time.Second,
		// 慢速客户端不能长期占住连接。WriteTimeout 不设：WebSocket 是长连接，
		// 劫持后不受其约束，但设了会截断慢速大响应（历史查询导出）。写超时由 WS 的 SetWriteDeadline 负责。
		ReadTimeout:    30 * time.Second,
		IdleTimeout:    60 * time.Second,
		MaxHeaderBytes: 64 << 10,
		TLSConfig:      tlsConf,
	}

	go func() {
		logger.Info("factorybridge gateway listening", "version", version.Version, "addr", scheme+"://"+server.Addr, "channels", len(cfg.Channels), "tags", len(cfg.Tags))
		var err error
		if tlsConf != nil {
			err = server.ListenAndServeTLS("", "") // 证书已在 TLSConfig 中
		} else {
			err = server.ListenAndServe()
		}
		if err != nil && !errors.Is(err, http.ErrServerClosed) {
			logger.Error("http server stopped", "error", err)
			os.Exit(1)
		}
	}()

	<-ctx.Done()

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := server.Shutdown(shutdownCtx); err != nil {
		logger.Error("graceful shutdown", "error", err)
	}
	northboundPublisher.Stop()
	if err := engine.Stop(shutdownCtx); err != nil {
		logger.Error("stop acquisition engine", "error", err)
	}
	logger.Info("factorybridge gateway stopped")
	return exitOK
}

func stringRaw(root any, key, fallback string) string {
	if values, ok := root.(map[string]any); ok {
		if value, ok := values[key].(string); ok && value != "" {
			return value
		}
	}
	return fallback
}
func boolRaw(root any, key string) bool {
	if values, ok := root.(map[string]any); ok {
		value, _ := values[key].(bool)
		return value
	}
	return false
}
func intRaw(root any, key string, fallback int) int {
	if values, ok := root.(map[string]any); ok {
		if value, ok := values[key].(float64); ok && value > 0 {
			return int(value)
		}
	}
	return fallback
}

func toAcquisitionChannels(cfg config.Config) []acquisition.Channel {
	channels := make([]acquisition.Channel, 0, len(cfg.Channels))
	for _, channel := range cfg.Channels {
		channels = append(channels, acquisition.Channel{
			ID: channel.ID, Protocol: channel.Protocol, Host: channel.Host, Port: channel.Port,
			Enabled: channel.Enabled, PollIntervalMs: channel.PollIntervalMs, Params: channel.Params,
		})
	}
	return channels
}

func toAcquisitionTags(cfg config.Config) []acquisition.Tag {
	tags := make([]acquisition.Tag, 0, len(cfg.Tags))
	for _, tag := range cfg.Tags {
		tags = append(tags, acquisition.Tag{
			ID: tag.ID, ChannelID: tag.ChannelID, Name: tag.Name, Address: tag.Address,
			DataType: tag.DataType, Scale: tag.Scale, Offset: tag.Offset,
		})
	}
	return tags
}

func envOr(name, fallback string) string {
	if value := os.Getenv(name); value != "" {
		return value
	}
	return fallback
}

// tdenginePassword 返回 TDENGINE_PASSWORD。设置了 TDENGINE_URL 时必须显式提供密码，不使用内置默认值。
func tdenginePassword() (string, error) {
	password := setting("tdenginePassword", "")
	if setting("tdengineURL", "") != "" && password == "" {
		return "", errors.New("TDengine URL is set but FB_TDENGINE_PASSWORD (or TDENGINE_PASSWORD) is empty; set the TDengine password explicitly")
	}
	return password, nil
}

func envInt(name string, fallback int) int {
	value := os.Getenv(name)
	if value == "" {
		return fallback
	}
	n, err := strconv.Atoi(value)
	if err != nil || n < 1 || n > 65535 {
		fmt.Fprintf(os.Stderr, "invalid %s=%q, using %d\n", name, value, fallback)
		return fallback
	}
	return n
}

func splitCSV(value string) []string {
	if value == "" {
		return nil
	}
	parts := strings.Split(value, ",")
	result := make([]string, 0, len(parts))
	for _, part := range parts {
		if trimmed := strings.TrimSpace(part); trimmed != "" {
			result = append(result, trimmed)
		}
	}
	return result
}

func envDuration(name string, fallback time.Duration) time.Duration {
	return parseDuration(os.Getenv(name), fallback)
}

func parseDuration(value string, fallback time.Duration) time.Duration {
	if value == "" {
		return fallback
	}
	duration, err := time.ParseDuration(value)
	if err != nil || duration <= 0 {
		return fallback
	}
	return duration
}

func envBool(name string, fallback bool) bool {
	return parseBool(os.Getenv(name), fallback)
}

func parseBool(raw string, fallback bool) bool {
	value := strings.ToLower(strings.TrimSpace(raw))
	switch value {
	case "1", "true", "yes", "on":
		return true
	case "0", "false", "no", "off":
		return false
	default:
		return fallback
	}
}
