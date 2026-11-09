package main

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/factorybridge/iotconnector/gateway-go/internal/auth"
	"github.com/factorybridge/iotconnector/gateway-go/internal/db"
	"golang.org/x/crypto/bcrypt"
)

const covGoodPassword = "Correct-Horse-42!"

// covStdin 把 os.Stdin 换成一个只含 content 的管道，测试结束后恢复。
func covStdin(t *testing.T, content string) {
	t.Helper()
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := w.WriteString(content); err != nil {
		t.Fatal(err)
	}
	_ = w.Close()
	old := os.Stdin
	os.Stdin = r
	t.Cleanup(func() {
		os.Stdin = old
		_ = r.Close()
	})
}

// covUser 调用 dispatch 执行 user 子命令，返回退出码与输出。
func covUser(t *testing.T, dir string, args ...string) (int, string, string) {
	t.Helper()
	full := append([]string{"user"}, args...)
	full = append(full, "--data-dir", dir)
	var stdout, stderr bytes.Buffer
	code := dispatch(full, &stdout, &stderr)
	return code, stdout.String(), stderr.String()
}

func TestUserCreateAndList(t *testing.T) {
	dir := t.TempDir()
	covStdin(t, covGoodPassword+"\n")
	code, out, errOut := covUser(t, dir, "create", "--name", "alice", "--password-stdin")
	if code != exitOK || !strings.Contains(out, "已创建用户 alice（viewer）") {
		t.Fatalf("create: exit=%d out=%q err=%q", code, out, errOut)
	}

	code, out, _ = covUser(t, dir, "list")
	if code != exitOK {
		t.Fatalf("list exit=%d", code)
	}
	if !strings.Contains(out, "USERNAME") || !strings.Contains(out, "alice") || !strings.Contains(out, "viewer") || !strings.Contains(out, "active") {
		t.Errorf("list output missing alice row: %q", out)
	}
}

func TestUserCreateWithRole(t *testing.T) {
	dir := t.TempDir()
	covStdin(t, covGoodPassword+"\n")
	code, out, errOut := covUser(t, dir, "create", "--name", "bob", "--role", "engineer", "--password-stdin")
	if code != exitOK || !strings.Contains(out, "已创建用户 bob（engineer）") {
		t.Fatalf("exit=%d out=%q err=%q", code, out, errOut)
	}
}

func TestUserCreateRejectsBadInput(t *testing.T) {
	dir := t.TempDir()
	covStdin(t, covGoodPassword+"\n")
	if code, out, errOut := covUser(t, dir, "create", "--name", "carol", "--role", "root", "--password-stdin"); code != exitUsage || !strings.Contains(errOut, "无效角色") {
		t.Errorf("bad role: exit=%d out=%q err=%q", code, out, errOut)
	}

	covStdin(t, "short\n")
	if code, _, errOut := covUser(t, dir, "create", "--name", "carol", "--password-stdin"); code != exitUsage || !strings.Contains(errOut, "at least 12") {
		t.Errorf("weak password: exit=%d err=%q", code, errOut)
	}

	if code, _, errOut := covUser(t, dir, "create", "--password-stdin"); code != exitUsage || !strings.Contains(errOut, "缺少 --name") {
		t.Errorf("missing name: exit=%d err=%q", code, errOut)
	}
}

func TestUserCreateDuplicate(t *testing.T) {
	dir := t.TempDir()
	covStdin(t, covGoodPassword+"\n")
	if code, _, _ := covUser(t, dir, "create", "--name", "dup", "--password-stdin"); code != exitOK {
		t.Fatalf("first create exit=%d", code)
	}
	covStdin(t, covGoodPassword+"\n")
	if code, _, _ := covUser(t, dir, "create", "--name", "dup", "--password-stdin"); code != exitUsage {
		t.Errorf("duplicate create exit=%d, want exitUsage", code)
	}
}

func TestUserCreateInteractiveNeedsTerminal(t *testing.T) {
	dir := t.TempDir()
	// 管道不是终端：交互式口令必须报错而不是挂起，即使从终端启动 go test 也一样。
	covStdin(t, "")
	code, _, errOut := covUser(t, dir, "create", "--name", "erin")
	if code != exitUsage || !strings.Contains(errOut, "--password-stdin") {
		t.Errorf("exit=%d err=%q", code, errOut)
	}
}

func TestUserHelpAndUnknownSubcommand(t *testing.T) {
	var stdout, stderr bytes.Buffer
	if code := cmdUser(nil, &stdout, &stderr); code != exitUsage || !strings.Contains(stdout.String(), "用法") {
		t.Errorf("no args: exit=%d out=%q", code, stdout.String())
	}
	stdout.Reset()
	if code := cmdUser([]string{"-h"}, &stdout, &stderr); code != exitOK || !strings.Contains(stdout.String(), "用法") {
		t.Errorf("-h: exit=%d out=%q", code, stdout.String())
	}

	dir := t.TempDir()
	covStdin(t, covGoodPassword+"\n")
	covUser(t, dir, "create", "--name", "frank", "--password-stdin")
	if code, _, errOut := covUser(t, dir, "frobnicate", "--name", "frank"); code != exitUsage || !strings.Contains(errOut, "未知子命令") {
		t.Errorf("unknown sub: exit=%d err=%q", code, errOut)
	}
}

func TestUserRoleDisableEnable(t *testing.T) {
	dir := t.TempDir()
	covStdin(t, covGoodPassword+"\n")
	covUser(t, dir, "create", "--name", "gina", "--password-stdin")

	if code, out, errOut := covUser(t, dir, "role", "--name", "gina", "--role", "operator"); code != exitOK || !strings.Contains(out, "已更新 gina") {
		t.Fatalf("role: exit=%d out=%q err=%q", code, out, errOut)
	}
	if _, out, _ := covUser(t, dir, "list"); !strings.Contains(out, "operator") {
		t.Errorf("list after role change: %q", out)
	}
	if code, _, errOut := covUser(t, dir, "role", "--name", "gina", "--role", "root"); code != exitUsage || !strings.Contains(errOut, "无效角色") {
		t.Errorf("bad role: exit=%d err=%q", code, errOut)
	}

	if code, _, _ := covUser(t, dir, "disable", "--name", "gina"); code != exitOK {
		t.Fatalf("disable exit=%d", code)
	}
	if _, out, _ := covUser(t, dir, "list"); !strings.Contains(out, "disabled") {
		t.Errorf("list after disable: %q", out)
	}
	if code, _, _ := covUser(t, dir, "enable", "--name", "gina"); code != exitOK {
		t.Fatalf("enable exit=%d", code)
	}
	if _, out, _ := covUser(t, dir, "list"); strings.Contains(out, "disabled") {
		t.Errorf("list after enable still disabled: %q", out)
	}
}

func TestUserPasswdAndUnlock(t *testing.T) {
	dir := t.TempDir()
	covStdin(t, covGoodPassword+"\n")
	covUser(t, dir, "create", "--name", "hank", "--password-stdin")

	covStdin(t, "Another-Pass-99!\n")
	if code, out, errOut := covUser(t, dir, "passwd", "--name", "hank", "--password-stdin"); code != exitOK || !strings.Contains(out, "已更新 hank") {
		t.Errorf("passwd: exit=%d out=%q err=%q", code, out, errOut)
	}
	covStdin(t, "weak\n")
	if code, _, _ := covUser(t, dir, "passwd", "--name", "hank", "--password-stdin"); code != exitUsage {
		t.Errorf("weak passwd exit=%d, want exitUsage", code)
	}
	if code, out, _ := covUser(t, dir, "unlock", "--name", "hank"); code != exitOK || !strings.Contains(out, "已解锁 hank") {
		t.Errorf("unlock: exit=%d out=%q", code, out)
	}
}

func TestUserDeleteAndMissingUser(t *testing.T) {
	dir := t.TempDir()
	covStdin(t, covGoodPassword+"\n")
	covUser(t, dir, "create", "--name", "ivy", "--password-stdin")

	if code, out, _ := covUser(t, dir, "delete", "--name", "ivy"); code != exitOK || !strings.Contains(out, "已删除 ivy") {
		t.Fatalf("delete: exit=%d out=%q", code, out)
	}
	if _, out, _ := covUser(t, dir, "list"); strings.Contains(out, "ivy") {
		t.Errorf("ivy still listed after delete: %q", out)
	}
	if code, _, _ := covUser(t, dir, "role", "--name", "ivy", "--role", "admin"); code != exitUsage {
		t.Errorf("role on deleted user exit=%d, want exitUsage", code)
	}
}

func TestEnsureDevAccount(t *testing.T) {
	ctx := context.Background()
	database, err := db.Open(ctx, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = database.Close() })
	store := auth.NewUserStore(database, auth.UserStoreOptions{})
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))

	if err := ensureDevAccount(ctx, store, "", logger); err != nil {
		t.Fatalf("generated password: %v", err)
	}
	u, err := store.GetUserByName(ctx, "dev")
	if err != nil || u.Role != auth.RoleAdmin {
		t.Fatalf("dev account: %+v err=%v", u, err)
	}

	if err := ensureDevAccount(ctx, store, covGoodPassword, logger); err != nil {
		t.Fatalf("explicit password on existing account: %v", err)
	}
	if err := ensureDevAccount(ctx, store, "weak", logger); err == nil || !strings.Contains(err.Error(), "FB_DEV_PASSWORD") {
		t.Errorf("weak FB_DEV_PASSWORD error = %v", err)
	}
}

func TestOpenUserStoreImportsLegacyAdmin(t *testing.T) {
	dir := t.TempDir()
	hash, err := bcrypt.GenerateFromPassword([]byte(covGoodPassword), bcrypt.MinCost)
	if err != nil {
		t.Fatal(err)
	}
	legacy, _ := json.Marshal(map[string]any{"username": "legacy-admin", "hash": string(hash), "mustChangePassword": false})
	authPath := filepath.Join(dir, "auth.json")
	if err := os.WriteFile(authPath, legacy, 0o600); err != nil {
		t.Fatal(err)
	}

	var out bytes.Buffer
	store, database, err := openUserStore(context.Background(), dir, &out)
	if err != nil {
		t.Fatalf("openUserStore: %v", err)
	}
	t.Cleanup(func() { _ = database.Close() })

	if !strings.Contains(out.String(), `imported legacy admin "legacy-admin"`) {
		t.Errorf("stdout = %q", out.String())
	}
	u, err := store.GetUserByName(context.Background(), "legacy-admin")
	if err != nil || u.Role != auth.RoleAdmin {
		t.Fatalf("imported user: %+v err=%v", u, err)
	}
	if _, err := os.Stat(authPath); !os.IsNotExist(err) {
		t.Errorf("auth.json should be renamed, stat err=%v", err)
	}
	if _, err := os.Stat(authPath + ".migrated"); err != nil {
		t.Errorf("auth.json.migrated missing: %v", err)
	}
}

// 未知子命令在打开数据库之前就被拒绝，不会在数据目录里建库。
func TestUserUnknownSubcommandDoesNotOpenStore(t *testing.T) {
	dir := t.TempDir()
	var stdout, stderr bytes.Buffer
	if code := dispatch([]string{"user", "frobnicate", "--name", "ghost", "--data-dir", dir}, &stdout, &stderr); code != exitUsage {
		t.Fatalf("exit = %d, stderr = %s", code, stderr.String())
	}
	if !strings.Contains(stderr.String(), "未知子命令") {
		t.Fatalf("stderr = %q", stderr.String())
	}
	if isFile(filepath.Join(dir, "gateway.db")) {
		t.Fatal("unknown subcommand must not create gateway.db")
	}
}
