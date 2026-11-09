package main

import (
	"context"
	"flag"
	"fmt"
	"io"
	"os"
	"strconv"

	"github.com/factorybridge/iotconnector/gateway-go/internal/config"
)

// cmdConfig 实现 config list|export（G6）：查看与导出 gateway.db 中保存的配置版本。
// 导出的文件可直接作为 config.json，或经控制台"恢复配置"导入。
func cmdConfig(args []string, stdout, stderr io.Writer) int {
	if len(args) == 0 || args[0] == "-h" || args[0] == "--help" {
		fmt.Fprintln(stdout, "用法：factorybridge config <list|export> [参数]")
		fmt.Fprintln(stdout, "  list   [--limit 20]                     列出最近的配置版本")
		fmt.Fprintln(stdout, "  export [--version N] [--out 文件]       导出指定版本（默认最新），不指定 --out 时输出到标准输出")
		fmt.Fprintln(stdout, "通用参数：--data-dir 数据目录")
		if len(args) == 0 {
			return exitUsage
		}
		return exitOK
	}
	sub, rest := args[0], args[1:]
	switch sub {
	case "list", "export":
	default:
		fmt.Fprintf(stderr, "未知子命令 config %s\n", sub)
		return exitUsage
	}
	fs := flag.NewFlagSet("config "+sub, flag.ContinueOnError)
	fs.SetOutput(stderr)
	dataDir := fs.String("data-dir", setting("dataDir", defaultDataDir()), "数据目录；环境变量 FB_DATA_DIR")
	limit := fs.Int("limit", 20, "list：显示的版本数")
	version := fs.Int64("version", 0, "export：版本号，0 表示最新")
	out := fs.String("out", "", "export：输出文件；省略时写到标准输出")
	if code, done := parseFlags(fs, rest); done {
		return code
	}
	if resolved, err := dataDirFlag(fs, *dataDir, stderr); err != nil {
		fmt.Fprintln(stderr, err)
		return exitConfig
	} else {
		*dataDir = resolved
	}
	ctx := context.Background()
	_, database, err := openUserStore(ctx, *dataDir, stderr)
	if err != nil {
		fmt.Fprintf(stderr, "打开状态库失败：%v\n", err)
		return exitConfig
	}
	defer database.Close()
	store := config.NewStoreDB(*dataDir, database)
	// Load 会在库中没有版本时导入 config.json，保证 list/export 总能看到当前配置。
	if _, err := store.Load(); err != nil {
		fmt.Fprintf(stderr, "读取配置失败：%v\n", err)
		return exitConfig
	}

	if sub == "list" {
		versions, err := store.Versions(ctx, *limit)
		if err != nil {
			fmt.Fprintln(stderr, err)
			return exitError
		}
		fmt.Fprintf(stdout, "%-8s %-20s %-20s %s\n", "VERSION", "SAVED AT", "ACTOR", "SHA256")
		for _, v := range versions {
			fmt.Fprintf(stdout, "%-8d %-20s %-20s %s\n", v.Version, v.SavedAt.Format("2006-01-02 15:04:05"), v.Actor, v.SHA256[:12])
		}
		return exitOK
	}

	target := *version
	if target == 0 {
		versions, err := store.Versions(ctx, 1)
		if err != nil || len(versions) == 0 {
			fmt.Fprintln(stderr, "没有可导出的配置版本")
			return exitError
		}
		target = versions[0].Version
	}
	body, err := store.VersionBody(ctx, target)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return exitUsage
	}
	if *out == "" {
		fmt.Fprintln(stdout, body)
		return exitOK
	}
	if err := os.WriteFile(*out, []byte(body+"\n"), 0o640); err != nil {
		fmt.Fprintln(stderr, err)
		return exitError
	}
	fmt.Fprintf(stderr, "已导出版本 %s 到 %s\n", strconv.FormatInt(target, 10), *out)
	return exitOK
}
