//go:build windows

package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"time"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/svc"
	"golang.org/x/sys/windows/svc/mgr"
)

// Windows 服务：直接用 SCM API 注册（golang.org/x/sys/windows/svc），替代 WinSW。
//   - 运行账号：虚拟账号 NT SERVICE\<name>（非 LocalSystem），install 时给数据目录授予修改权限
//   - 启动类型：延迟自动启动；异常退出后 10s/30s/60s 自动重启
//   - 服务进程设置 FB_SERVICE=1，run 据此拒绝开发模式

func runServiceAction(action string, opts serviceOptions, stdout io.Writer) error {
	switch action {
	case "install":
		return installWindowsService(opts, stdout)
	case "uninstall":
		return withService(opts.name, func(s *mgr.Service) error {
			_ = stopService(s)
			if err := s.Delete(); err != nil {
				return err
			}
			fmt.Fprintf(stdout, "已卸载服务 %s（数据目录未删除）\n", opts.name)
			return nil
		})
	case "start":
		return withService(opts.name, func(s *mgr.Service) error {
			if err := s.Start(); err != nil {
				return err
			}
			return waitState(s, svc.Running, stdout)
		})
	case "stop":
		return withService(opts.name, stopService)
	case "restart":
		return withService(opts.name, func(s *mgr.Service) error {
			if err := stopService(s); err != nil {
				return err
			}
			if err := s.Start(); err != nil {
				return err
			}
			return waitState(s, svc.Running, stdout)
		})
	case "status":
		return queryServiceStatus(opts.name, stdout)
	}
	return errUnknownAction
}

// queryServiceStatus 以只读权限查询服务，普通用户也能执行。
// mgr.Connect 固定申请 SC_MANAGER_ALL_ACCESS，非管理员会被拒绝，所以这里直接调用 Win32 API。
func queryServiceStatus(name string, stdout io.Writer) error {
	scm, err := windows.OpenSCManager(nil, nil, windows.SC_MANAGER_CONNECT)
	if err != nil {
		return fmt.Errorf("连接服务管理器失败：%w", err)
	}
	defer windows.CloseServiceHandle(scm)
	namePtr, err := windows.UTF16PtrFromString(name)
	if err != nil {
		return err
	}
	handle, err := windows.OpenService(scm, namePtr, windows.SERVICE_QUERY_STATUS|windows.SERVICE_QUERY_CONFIG)
	if err != nil {
		if errors.Is(err, windows.ERROR_SERVICE_DOES_NOT_EXIST) {
			fmt.Fprintf(stdout, "服务 %s：未安装\n", name)
			return nil
		}
		return fmt.Errorf("打开服务 %s 失败：%w", name, err)
	}
	service := &mgr.Service{Name: name, Handle: handle}
	defer service.Close()
	status, err := service.Query()
	if err != nil {
		return err
	}
	cfg, _ := service.Config()
	fmt.Fprintf(stdout, "服务 %s：%s（PID %d）\n命令：%s\n账号：%s\n", name, stateName(status.State), status.ProcessId, cfg.BinaryPathName, cfg.ServiceStartName)
	return nil
}

func installWindowsService(opts serviceOptions, stdout io.Writer) error {
	m, err := mgr.Connect()
	if err != nil {
		return fmt.Errorf("连接服务管理器失败（需要以管理员身份运行）：%w", err)
	}
	defer m.Disconnect()
	if existing, err := m.OpenService(opts.name); err == nil {
		existing.Close()
		return fmt.Errorf("服务 %s 已存在；先 service uninstall --name %s", opts.name, opts.name)
	}
	account := `NT SERVICE\` + opts.name
	s, err := m.CreateService(opts.name, opts.exe, mgr.Config{
		DisplayName:      "FactoryBridge Gateway (" + opts.name + ")",
		Description:      "FactoryBridge IIoT edge gateway",
		StartType:        mgr.StartAutomatic,
		DelayedAutoStart: true,
		ServiceStartName: account,
	}, serviceCommandLine(opts)...)
	if err != nil {
		return fmt.Errorf("创建服务失败：%w", err)
	}
	defer s.Close()
	_ = s.SetRecoveryActions([]mgr.RecoveryAction{
		{Type: mgr.ServiceRestart, Delay: 10 * time.Second},
		{Type: mgr.ServiceRestart, Delay: 30 * time.Second},
		{Type: mgr.ServiceRestart, Delay: 60 * time.Second},
	}, 24*3600)
	// 虚拟账号默认无权写数据目录；授予修改权限（含子目录与文件继承）
	grant := exec.Command("icacls", opts.dataDir, "/grant", account+":(OI)(CI)M", "/T", "/Q")
	if out, err := grant.CombinedOutput(); err != nil {
		_ = s.Delete()
		return fmt.Errorf("为 %s 授予数据目录权限失败：%v\n%s", account, err, out)
	}
	fmt.Fprintf(stdout, "已安装服务 %s，运行账号 %s\n命令：%s %v\n启动：factorybridge service start --name %s\n",
		opts.name, account, opts.exe, serviceCommandLine(opts), opts.name)
	return nil
}

func withService(name string, fn func(*mgr.Service) error) error {
	m, err := mgr.Connect()
	if err != nil {
		return fmt.Errorf("连接服务管理器失败：%w", err)
	}
	defer m.Disconnect()
	s, err := m.OpenService(name)
	if err != nil {
		return fmt.Errorf("服务 %s 不存在或无权访问：%w", name, err)
	}
	defer s.Close()
	return fn(s)
}

func stopService(s *mgr.Service) error {
	status, err := s.Query()
	if err != nil || status.State == svc.Stopped {
		return err
	}
	if _, err := s.Control(svc.Stop); err != nil {
		return err
	}
	return waitState(s, svc.Stopped, io.Discard)
}

func waitState(s *mgr.Service, want svc.State, stdout io.Writer) error {
	deadline := time.Now().Add(30 * time.Second)
	for time.Now().Before(deadline) {
		status, err := s.Query()
		if err != nil {
			return err
		}
		if status.State == want {
			fmt.Fprintf(stdout, "服务状态：%s\n", stateName(want))
			return nil
		}
		time.Sleep(300 * time.Millisecond)
	}
	return fmt.Errorf("等待服务进入 %s 超时", stateName(want))
}

func stateName(state svc.State) string {
	return map[svc.State]string{svc.Stopped: "已停止", svc.StartPending: "启动中", svc.StopPending: "停止中", svc.Running: "运行中",
		svc.ContinuePending: "恢复中", svc.PausePending: "暂停中", svc.Paused: "已暂停"}[state]
}

// runningUnderSCM 判断当前进程是否由服务管理器启动。
func runningUnderSCM() bool {
	ok, err := svc.IsWindowsService()
	return err == nil && ok
}

// runAsWindowsService 在 SCM 下运行 run：收到 Stop/Shutdown 时取消 ctx，网关按正常流程关停。
func runAsWindowsService(name string, run func(ctx context.Context) int) int {
	_ = os.Setenv("FB_SERVICE", "1")
	handler := &serviceHandler{run: run}
	if err := svc.Run(name, handler); err != nil {
		return exitError
	}
	return handler.code
}

type serviceHandler struct {
	run  func(ctx context.Context) int
	code int
}

func (h *serviceHandler) Execute(_ []string, requests <-chan svc.ChangeRequest, status chan<- svc.Status) (bool, uint32) {
	status <- svc.Status{State: svc.StartPending}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan int, 1)
	go func() { done <- h.run(ctx) }()
	status <- svc.Status{State: svc.Running, Accepts: svc.AcceptStop | svc.AcceptShutdown}
	for {
		select {
		case code := <-done:
			h.code = code
			cancel()
			return false, uint32(code)
		case req := <-requests:
			switch req.Cmd {
			case svc.Interrogate:
				status <- req.CurrentStatus
			case svc.Stop, svc.Shutdown:
				status <- svc.Status{State: svc.StopPending, WaitHint: 20000}
				cancel()
				h.code = <-done
				return false, 0
			}
		}
	}
}
