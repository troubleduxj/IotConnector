package main

import (
	"context"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/factorybridge/iotconnector/gateway-go/internal/acquisition"
	"github.com/factorybridge/iotconnector/gateway-go/internal/api"
	"github.com/factorybridge/iotconnector/gateway-go/internal/audit"
	"github.com/factorybridge/iotconnector/gateway-go/internal/config"
	"github.com/factorybridge/iotconnector/gateway-go/internal/db"
	"github.com/factorybridge/iotconnector/gateway-go/internal/northbound"
	"github.com/factorybridge/iotconnector/gateway-go/internal/storage"
)

// legacyFiles 是 G5 要导入的旧状态文件（相对数据目录）。
var legacyFiles = []string{"auth.json", "outbox.json", "alarm-outbox.json", "history.jsonl", "audit.jsonl", "shadow.json", "northbound.json"}

// cmdMigrate 离线执行与 run 首次启动相同的旧文件导入，并报告结果（G5）。
// 导入是幂等的：库中已有数据的类别会跳过，已改名为 .migrated 的文件不会再读。
// 网关运行中执行也安全（SQLite WAL），但建议先停网关，避免 run 与 migrate 同时导入同一文件。
func cmdMigrate(args []string, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("migrate", flag.ContinueOnError)
	fs.SetOutput(stderr)
	dataDir := fs.String("data-dir", envOr("GATEWAY_GO_DATA_DIR", defaultDataDir()), "数据目录")
	dryRun := fs.Bool("dry-run", false, "只列出待导入的文件，不修改任何内容")
	if code, done := parseFlags(fs, args); done {
		return code
	}
	pending := pendingLegacyFiles(*dataDir)
	if len(pending) == 0 {
		fmt.Fprintln(stdout, "没有待导入的旧状态文件。")
		return exitOK
	}
	fmt.Fprintln(stdout, "待导入：")
	for _, file := range pending {
		info, _ := os.Stat(filepath.Join(*dataDir, file))
		size := int64(0)
		if info != nil {
			size = info.Size()
		}
		fmt.Fprintf(stdout, "  %-28s %10d 字节\n", file, size)
	}
	if *dryRun {
		return exitOK
	}

	ctx := context.Background()
	started := time.Now()
	users, database, err := openUserStore(ctx, *dataDir, stdout)
	if err != nil {
		fmt.Fprintf(stderr, "打开状态库失败：%v\n", err)
		return exitConfig
	}
	defer database.Close()
	_ = users
	batch := db.NewBatch(database)

	// 依次触发各存储的导入逻辑（与 run 共用同一实现）
	storage.New(storage.Config{URL: "migrate://offline", State: batch, StateDB: database,
		QueueFile: filepath.Join(*dataDir, "outbox.json"), AlarmQueueFile: filepath.Join(*dataDir, "alarm-outbox.json"), MaxQueue: envInt("GATEWAY_GO_OUTBOX_MAX", 100000)})
	audit.NewDB(database, filepath.Join(*dataDir, "audit.jsonl"))
	api.NewServerWithOptions(config.Config{}, acquisition.NewEngine(nil, nil, nil), api.SecurityOptions{
		StateDB: database, State: batch,
		HistoryFile: filepath.Join(*dataDir, "history.jsonl"), ShadowFile: filepath.Join(*dataDir, "shadow.json"),
	})
	northbound.NewDB(northbound.Config{}, database, batch, filepath.Join(*dataDir, "northbound.json"), nil, nil)
	if err := batch.Flush(ctx); err != nil {
		fmt.Fprintf(stderr, "写入状态库失败：%v\n", err)
		return exitError
	}

	fmt.Fprintf(stdout, "\n完成，用时 %s。状态库 %s 中的记录数：\n", time.Since(started).Round(time.Millisecond), database.Path)
	for _, table := range []string{"users", "outbox_points", "outbox_alarms", "history_points", "alarm_events", "audit_events", "shadow_entries", "northbound_queue"} {
		var n int
		_ = database.QueryRow("SELECT COUNT(*) FROM " + table).Scan(&n)
		fmt.Fprintf(stdout, "  %-18s %d\n", table, n)
	}
	if left := pendingLegacyFiles(*dataDir); len(left) > 0 {
		fmt.Fprintf(stderr, "\n以下文件未导入（对应类别库中已有数据，或文件损坏）：%s\n", strings.Join(left, ", "))
		return exitError
	}
	fmt.Fprintln(stdout, "\n原文件已改名为 *.migrated。确认网关运行正常后可删除。")
	return exitOK
}

func pendingLegacyFiles(dataDir string) []string {
	var out []string
	for _, name := range legacyFiles {
		if _, err := os.Stat(filepath.Join(dataDir, name)); err == nil {
			out = append(out, name)
		}
	}
	parts, _ := filepath.Glob(filepath.Join(dataDir, "outbox.json.part-*"))
	for _, part := range parts {
		if !strings.HasSuffix(part, ".migrated") {
			out = append(out, filepath.Base(part))
		}
	}
	return out
}
