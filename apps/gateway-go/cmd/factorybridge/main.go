package main

import (
	"context"
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
	"github.com/factorybridge/iotconnector/gateway-go/internal/northbound"
	"github.com/factorybridge/iotconnector/gateway-go/internal/storage"
	"github.com/factorybridge/iotconnector/gateway-go/internal/version"
)

// runGateway 是原 main 的主体，行为不变；路径和端口改由命令行参数传入（缺省仍读环境变量）。
func runGateway(opts runOptions) int {
	logger := slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: opts.logLevel}))
	dataDir := opts.dataDir
	port := opts.port

	store := config.NewStore(dataDir)
	cfg, err := store.Load()
	if err != nil {
		logger.Error("load config", "error", err)
		return exitConfig
	}
	engine := acquisition.NewEngine(toAcquisitionChannels(cfg), toAcquisitionTags(cfg), acquisition.NewFactory())
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := engine.Start(ctx); err != nil {
		logger.Error("start acquisition engine", "error", err)
		return exitError
	}
	tdengineURL := os.Getenv("TDENGINE_URL")
	queueFile := ""
	if tdengineURL != "" {
		queueFile = filepath.Join(dataDir, "outbox.json")
	}
	storageWriter := storage.New(storage.Config{
		URL: tdengineURL, User: envOr("TDENGINE_USER", "root"), Password: envOr("TDENGINE_PASSWORD", "taosdata"),
		Database: envOr("TDENGINE_DB", "factory_bridge"), SuperTable: envOr("TDENGINE_STABLE", "st_factory_equipment"),
		QueueFile: queueFile, AlarmQueueFile: func() string {
			if queueFile == "" {
				return ""
			}
			return filepath.Join(dataDir, "alarm-outbox.json")
		}(),
		MaxQueue: envInt("GATEWAY_GO_OUTBOX_MAX", 100000), SegmentSize: envInt("GATEWAY_GO_OUTBOX_SEGMENT_SIZE", 10000),
	})
	auditLogger := audit.New(filepath.Join(dataDir, "audit.jsonl"))
	users, database, err := openUserStore(ctx, dataDir, os.Stdout)
	if err != nil {
		logger.Error("open user store", "error", err)
		return exitConfig
	}
	defer database.Close()
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
			Token:         envOr("GATEWAY_GO_API_TOKEN", ""),
			ViewerToken:   envOr("GATEWAY_GO_VIEWER_TOKEN", ""),
			OperatorToken: envOr("GATEWAY_GO_OPERATOR_TOKEN", ""),
			AdminToken:    envOr("GATEWAY_GO_ADMIN_TOKEN", ""),
			Users:         users,
			DevMode:       opts.dev,
			DevNoAuth:     opts.devNoAuth,
			HistoryFile:   filepath.Join(dataDir, "history.jsonl"),
			Audit:         auditLogger,
			ConfigStore:   &store,
			Storage:       storageWriter,
			ShadowFile:    filepath.Join(dataDir, "shadow.json"),
			CORSOrigins:   splitCSV(os.Getenv("GATEWAY_GO_CORS_ORIGINS")),
		},
	)
	northboundPublisher := northbound.New(northbound.Config{Enabled: boolRaw(cfg.Raw["northbound"], "enabled"), URL: stringRaw(cfg.Raw["northbound"], "url", "mqtt://127.0.0.1:1883"), Username: stringRaw(cfg.Raw["northbound"], "username", ""), Password: stringRaw(cfg.Raw["northbound"], "password", ""), GroupID: stringRaw(cfg.Raw["northbound"], "groupId", "Factory"), EdgeNodeID: stringRaw(cfg.Raw["northbound"], "edgeNodeId", "FB_Edge_GW01"), DataFlushMs: intRaw(cfg.Raw["northbound"], "dataFlushMs", 1000)}, filepath.Join(dataDir, "northbound.json"), toAcquisitionChannels(cfg), toAcquisitionTags(cfg))
	northboundPublisher.OnCommand = func(name string, raw any) error {
		_ = auditLogger.Record(audit.Event{Actor: "mqtt", Action: "mqtt.cmd", Target: name, Detail: map[string]any{"value": raw}})
		for _, tag := range toAcquisitionTags(cfg) {
			if tag.Name != name {
				continue
			}
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
	serverHandler.AttachNorthbound(northboundPublisher)
	northboundPublisher.Start()
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
	}

	go func() {
		logger.Info("factorybridge gateway listening", "version", version.Version, "addr", "http://"+server.Addr, "channels", len(cfg.Channels), "tags", len(cfg.Tags))
		if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
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
	value := os.Getenv(name)
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
	value := strings.ToLower(strings.TrimSpace(os.Getenv(name)))
	switch value {
	case "1", "true", "yes", "on":
		return true
	case "0", "false", "no", "off":
		return false
	default:
		return fallback
	}
}

func defaultDataDir() string {
	candidates := []string{
		filepath.Join("apps", "gateway", "data"),
		filepath.Join("..", "gateway", "data"),
	}
	for _, candidate := range candidates {
		if info, err := os.Stat(candidate); err == nil && info.IsDir() {
			return candidate
		}
	}
	return candidates[0]
}
