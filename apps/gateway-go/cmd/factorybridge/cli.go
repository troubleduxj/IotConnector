// factorybridge 是 Factory Bridge 边缘网关的单一可执行文件，Windows 与 Linux 共用一套子命令。
//
// 用法：
//
//	factorybridge [命令] [参数]
//
// 不带命令时等同于 run，保持与旧启动脚本兼容。
package main

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"os"
	"sort"
	"strings"

	"github.com/factorybridge/iotconnector/gateway-go/internal/scriptworker"
	"github.com/factorybridge/iotconnector/gateway-go/internal/version"
)

// 退出码约定（H1）：脚本和服务管理器据此判断失败类别。
const (
	exitOK     = 0
	exitError  = 1 // 运行期错误
	exitUsage  = 2 // 命令或参数错误
	exitConfig = 3 // 配置或数据文件错误
)

type command struct {
	name    string
	summary string
	run     func(args []string, stdout, stderr io.Writer) int
}

var commands = map[string]command{}

func register(c command) { commands[c.name] = c }

func init() {
	register(command{name: "run", summary: "前台运行网关", run: cmdRun})
	register(command{name: "version", summary: "显示版本、提交号与构建时间", run: cmdVersion})
	register(command{name: "help", summary: "显示帮助", run: cmdHelp})
}

func main() {
	// 脚本隔离子进程复用同一可执行文件，必须在解析命令前分流。
	if os.Getenv("GATEWAY_GO_SCRIPT_WORKER") == "1" {
		if err := scriptworker.Run(); err != nil {
			os.Exit(exitError)
		}
		return
	}
	os.Exit(dispatch(os.Args[1:], os.Stdout, os.Stderr))
}

func dispatch(args []string, stdout, stderr io.Writer) int {
	name := "run"
	if len(args) > 0 && (args[0] == "-h" || args[0] == "--help" || args[0] == "-help") {
		name, args = "help", args[1:]
	} else if len(args) > 0 && !strings.HasPrefix(args[0], "-") {
		name, args = args[0], args[1:]
	}
	c, ok := commands[name]
	if !ok {
		fmt.Fprintf(stderr, "未知命令 %q\n\n", name)
		printUsage(stderr)
		return exitUsage
	}
	return c.run(args, stdout, stderr)
}

func printUsage(w io.Writer) {
	fmt.Fprintln(w, "用法：factorybridge <命令> [参数]")
	fmt.Fprintln(w, "\n命令：")
	names := make([]string, 0, len(commands))
	for name := range commands {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		fmt.Fprintf(w, "  %-10s %s\n", name, commands[name].summary)
	}
	fmt.Fprintln(w, "\n各命令的参数：factorybridge <命令> -h")
}

func cmdHelp(_ []string, stdout, _ io.Writer) int {
	printUsage(stdout)
	return exitOK
}

func cmdVersion(args []string, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("version", flag.ContinueOnError)
	fs.SetOutput(stderr)
	asJSON := fs.Bool("json", false, "以 JSON 输出")
	if code, done := parseFlags(fs, args); done {
		return code
	}
	info := version.Info()
	if *asJSON {
		_ = json.NewEncoder(stdout).Encode(info)
		return exitOK
	}
	fmt.Fprintf(stdout, "factorybridge %s", info["version"])
	if info["commit"] != "" {
		fmt.Fprintf(stdout, " (%s)", info["commit"])
	}
	fmt.Fprintf(stdout, "\n%s %s", info["go"], info["platform"])
	if info["buildTime"] != "" {
		fmt.Fprintf(stdout, " · built %s", info["buildTime"])
	}
	fmt.Fprintln(stdout)
	return exitOK
}

// runOptions 是 run 的参数。优先级：命令行 > 环境变量 > 默认值。
type runOptions struct {
	dataDir  string
	port     int
	logLevel slog.Level
}

func cmdRun(args []string, _ io.Writer, stderr io.Writer) int {
	fs := flag.NewFlagSet("run", flag.ContinueOnError)
	fs.SetOutput(stderr)
	dataDir := fs.String("data-dir", envOr("GATEWAY_GO_DATA_DIR", defaultDataDir()), "数据目录（config.json、auth.json 等）；环境变量 GATEWAY_GO_DATA_DIR")
	port := fs.Int("port", envInt("GATEWAY_GO_PORT", 18080), "HTTP 端口；环境变量 GATEWAY_GO_PORT")
	logLevel := fs.String("log-level", envOr("GATEWAY_GO_LOG_LEVEL", "info"), "日志级别 debug|info|warn|error")
	if code, done := parseFlags(fs, args); done {
		return code
	}
	if *port < 1 || *port > 65535 {
		fmt.Fprintf(stderr, "无效端口 %d\n", *port)
		return exitUsage
	}
	var level slog.Level
	if err := level.UnmarshalText([]byte(*logLevel)); err != nil {
		fmt.Fprintf(stderr, "无效日志级别 %q\n", *logLevel)
		return exitUsage
	}
	return runGateway(runOptions{dataDir: *dataDir, port: *port, logLevel: level})
}

// parseFlags 解析参数；返回 done=true 时调用方应直接以 code 退出（-h 或参数错误）。
func parseFlags(fs *flag.FlagSet, args []string) (int, bool) {
	if err := fs.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return exitOK, true
		}
		return exitUsage, true
	}
	if fs.NArg() > 0 {
		fmt.Fprintf(fs.Output(), "多余的参数：%s\n", strings.Join(fs.Args(), " "))
		return exitUsage, true
	}
	return 0, false
}
