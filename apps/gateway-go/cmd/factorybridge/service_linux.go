//go:build linux

package main

import (
	"context"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strings"
)

// Linux 服务：生成 systemd 单元并 enable。单元带加固项（专用账号、只读系统、仅数据目录可写）。

func unitPath(name string) string { return "/etc/systemd/system/" + name + ".service" }

// systemdUnit 生成单元文件内容。参数逐个加引号，路径含空格时也能正确解析。
func systemdUnit(opts serviceOptions) string {
	quoted := []string{systemdQuote(opts.exe)}
	for _, arg := range serviceCommandLine(opts) {
		quoted = append(quoted, systemdQuote(arg))
	}
	return fmt.Sprintf(`# 由 factorybridge service install 生成；修改参数请 uninstall 后重新 install
[Unit]
Description=FactoryBridge IIoT edge gateway (%[1]s)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=%[2]s
Group=%[2]s
ExecStart=%[3]s
Restart=on-failure
RestartSec=5
StartLimitIntervalSec=60
StartLimitBurst=5
KillSignal=SIGINT
TimeoutStopSec=20
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ProtectKernelTunables=true
ProtectControlGroups=true
RestrictSUIDSGID=true
ReadWritePaths=%[4]s
# 监听 1024 以下端口（如 443）时需要；默认端口 18080 用不到
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE

[Install]
WantedBy=multi-user.target
`, opts.name, opts.user, strings.Join(quoted, " "), systemdQuote(opts.dataDir))
}

func systemdQuote(value string) string {
	return `"` + strings.NewReplacer(`\`, `\\`, `"`, `\"`, "%", "%%", "$", "$$").Replace(value) + `"`
}

func runServiceAction(action string, opts serviceOptions, stdout io.Writer) error {
	switch action {
	case "install":
		if os.Geteuid() != 0 {
			return fmt.Errorf("install 需要 root 权限")
		}
		if _, err := os.Stat(unitPath(opts.name)); err == nil {
			return fmt.Errorf("%s 已存在；先 service uninstall --name %s", unitPath(opts.name), opts.name)
		}
		if exec.Command("id", "-u", opts.user).Run() != nil {
			if out, err := exec.Command("useradd", "--system", "--no-create-home", "--shell", "/usr/sbin/nologin", opts.user).CombinedOutput(); err != nil {
				return fmt.Errorf("创建账号 %s 失败：%v %s", opts.user, err, out)
			}
		}
		if out, err := exec.Command("chown", "-R", opts.user+":"+opts.user, opts.dataDir).CombinedOutput(); err != nil {
			return fmt.Errorf("设置数据目录属主失败：%v %s", err, out)
		}
		if err := os.WriteFile(unitPath(opts.name), []byte(systemdUnit(opts)), 0o644); err != nil {
			return err
		}
		if err := systemctl("daemon-reload"); err != nil {
			return err
		}
		if err := systemctl("enable", opts.name); err != nil {
			return err
		}
		fmt.Fprintf(stdout, "已安装 %s，运行账号 %s\n启动：factorybridge service start --name %s\n", unitPath(opts.name), opts.user, opts.name)
		return nil
	case "uninstall":
		_ = systemctl("disable", "--now", opts.name)
		if err := os.Remove(unitPath(opts.name)); err != nil && !os.IsNotExist(err) {
			return err
		}
		_ = systemctl("daemon-reload")
		fmt.Fprintf(stdout, "已卸载 %s（数据目录与账号未删除）\n", opts.name)
		return nil
	case "start", "stop", "restart":
		return systemctl(action, opts.name)
	case "status":
		cmd := exec.Command("systemctl", "status", "--no-pager", opts.name)
		cmd.Stdout, cmd.Stderr = stdout, stdout
		_ = cmd.Run() // 未运行时 status 返回非零，但输出仍有用
		return nil
	}
	return errUnknownAction
}

func systemctl(args ...string) error {
	if out, err := exec.Command("systemctl", args...).CombinedOutput(); err != nil {
		return fmt.Errorf("systemctl %s：%v %s", strings.Join(args, " "), err, out)
	}
	return nil
}

func runningUnderSCM() bool { return false }

func runAsWindowsService(string, func(context.Context) int) int { return exitUsage }
