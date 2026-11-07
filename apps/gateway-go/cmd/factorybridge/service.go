package main

import (
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

// service 子命令（H3）：Windows 注册为系统服务，Linux 生成并启用 systemd 单元。
// 平台相关实现在 service_windows.go / service_linux.go；其他平台返回不支持。
//
// 服务以 `factorybridge run --data-dir <绝对路径> [其余 run 参数]` 启动，参数在安装时固化，
// 改参数需 uninstall 后重新 install。数据目录必须是绝对路径：服务的工作目录不可依赖。

const defaultServiceName = "factorybridge"

type serviceOptions struct {
	name    string
	dataDir string
	runArgs []string // 透传给 run 的参数（--host、--port、--allow-cidr 等）
	exe     string
	user    string // Linux：运行账号；Windows 忽略（使用虚拟账号 NT SERVICE\<name>）
}

func cmdService(args []string, stdout, stderr io.Writer) int {
	if len(args) == 0 || args[0] == "-h" || args[0] == "--help" {
		fmt.Fprintln(stdout, "用法：factorybridge service <install|uninstall|start|stop|restart|status> [--name 名称] [--data-dir 绝对路径] [-- run 参数…]")
		fmt.Fprintln(stdout, "  install 需要管理员（Windows）或 root（Linux）权限。")
		fmt.Fprintln(stdout, "  例：factorybridge service install --data-dir D:\\FactoryBridge\\data -- --host 0.0.0.0 --allow-cidr 10.0.0.0/8")
		if len(args) == 0 {
			return exitUsage
		}
		return exitOK
	}
	action, rest := args[0], args[1:]
	var passthrough []string
	for i, arg := range rest {
		if arg == "--" {
			passthrough, rest = rest[i+1:], rest[:i]
			break
		}
	}
	fs := flag.NewFlagSet("service "+action, flag.ContinueOnError)
	fs.SetOutput(stderr)
	name := fs.String("name", defaultServiceName, "服务名；同机多实例时用不同名称")
	dataDir := fs.String("data-dir", "", "数据目录（绝对路径），install 时必填")
	user := fs.String("user", "factorybridge", "Linux 运行账号（install 时不存在则创建系统账号）")
	if code, done := parseFlags(fs, rest); done {
		return code
	}
	if err := validateServiceName(*name); err != nil {
		fmt.Fprintln(stderr, err)
		return exitUsage
	}
	if err := validateRunArgs(passthrough); err != nil {
		fmt.Fprintln(stderr, err)
		return exitUsage
	}
	exe, err := os.Executable()
	if err != nil {
		fmt.Fprintln(stderr, err)
		return exitError
	}
	exe, _ = filepath.EvalSymlinks(exe)
	opts := serviceOptions{name: *name, dataDir: *dataDir, runArgs: passthrough, exe: exe, user: *user}

	if action == "install" {
		if opts.dataDir == "" || !filepath.IsAbs(opts.dataDir) {
			fmt.Fprintln(stderr, "install 需要 --data-dir 绝对路径")
			return exitUsage
		}
		if err := os.MkdirAll(opts.dataDir, 0o750); err != nil {
			fmt.Fprintf(stderr, "创建数据目录失败：%v\n", err)
			return exitConfig
		}
	}
	err = runServiceAction(action, opts, stdout)
	switch {
	case err == nil:
		return exitOK
	case errors.Is(err, errUnknownAction):
		fmt.Fprintf(stderr, "未知操作 service %s\n", action)
		return exitUsage
	case errors.Is(err, errNotSupported):
		fmt.Fprintln(stderr, err)
		return exitUsage
	default:
		fmt.Fprintf(stderr, "service %s：%v\n", action, err)
		return exitError
	}
}

var (
	errUnknownAction = errors.New("unknown action")
	errNotSupported  = errors.New("service management is only supported on Windows and Linux (systemd)")
)

func validateServiceName(name string) error {
	if name == "" || len(name) > 64 {
		return fmt.Errorf("服务名长度须为 1-64")
	}
	for _, r := range name {
		if !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '-' || r == '_') {
			return fmt.Errorf("服务名只能包含字母、数字、- 和 _")
		}
	}
	return nil
}

// validateRunArgs 先用 run 的参数解析器检查透传参数，避免装好的服务一启动就因参数错误退出；
// 并拒绝 --dev：开发模式不能以服务方式运行（H5）。
func validateRunArgs(args []string) error {
	for _, arg := range args {
		trimmed := strings.TrimLeft(arg, "-")
		if strings.HasPrefix(trimmed, "dev") {
			return fmt.Errorf("服务不能以开发模式运行（%s）", arg)
		}
		if strings.HasPrefix(trimmed, "data-dir") {
			return fmt.Errorf("数据目录请用 service 的 --data-dir 指定，不要放在 -- 之后")
		}
	}
	fs := flag.NewFlagSet("run", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	for _, name := range []string{"host", "web-dir", "log-level", "tls-cert", "tls-key", "allow-cidr"} {
		fs.String(name, "", "")
	}
	fs.Int("port", 0, "")
	if err := fs.Parse(args); err != nil {
		return fmt.Errorf("-- 之后的 run 参数无效：%v", err)
	}
	if fs.NArg() > 0 {
		return fmt.Errorf("-- 之后有多余参数：%s", strings.Join(fs.Args(), " "))
	}
	return nil
}

// serviceCommandLine 返回服务实际执行的参数（不含可执行文件本身）。
func serviceCommandLine(opts serviceOptions) []string {
	return append([]string{"run", "--data-dir", opts.dataDir}, opts.runArgs...)
}
