package main

import (
	"bufio"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"

	"github.com/factorybridge/iotconnector/gateway-go/internal/auth"
	"github.com/factorybridge/iotconnector/gateway-go/internal/db"
	"golang.org/x/term"
)

// openUserStore 打开数据目录下的 gateway.db；首次打开且库中无用户时，
// 把旧的 auth.json（单个 admin，bcrypt 哈希）导入为 admin 用户（阶段 2 决定：只迁 admin）。
// 导入后 auth.json 改名为 auth.json.migrated，保留以备回滚。
func openUserStore(ctx context.Context, dataDir string, stdout io.Writer) (*auth.UserStore, *db.DB, error) {
	database, err := db.Open(ctx, dataDir)
	if err != nil {
		return nil, nil, err
	}
	store := auth.NewUserStore(database, auth.UserStoreOptions{SessionTTL: envDuration("GATEWAY_GO_SESSION_TTL", 0)})
	if err := migrateLegacyAuth(ctx, store, dataDir, stdout); err != nil {
		_ = database.Close()
		return nil, nil, err
	}
	return store, database, nil
}

func migrateLegacyAuth(ctx context.Context, store *auth.UserStore, dataDir string, stdout io.Writer) error {
	count, err := store.CountUsers(ctx)
	if err != nil || count > 0 {
		return err
	}
	path := filepath.Join(dataDir, "auth.json")
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("read legacy auth.json: %w", err)
	}
	var legacy struct {
		Username   string `json:"username"`
		Hash       string `json:"hash"`
		MustChange bool   `json:"mustChangePassword"`
	}
	if err := json.Unmarshal(data, &legacy); err != nil {
		return fmt.Errorf("parse legacy auth.json: %w", err)
	}
	if legacy.Username == "" || legacy.Hash == "" {
		return nil
	}
	if _, err := store.ImportUser(ctx, legacy.Username, legacy.Hash, auth.RoleAdmin, legacy.MustChange); err != nil {
		return fmt.Errorf("import legacy admin: %w", err)
	}
	if err := os.Rename(path, path+".migrated"); err != nil {
		return fmt.Errorf("rename auth.json after import: %w", err)
	}
	fmt.Fprintf(stdout, "imported legacy admin %q from auth.json into %s\n", legacy.Username, db.FileName)
	return nil
}

// cmdUser 实现 user create|list|passwd|role|unlock|disable|enable|delete。
// 直接操作数据目录下的 gateway.db；网关运行中也可执行（SQLite WAL 支持并发），改动即时生效。
func cmdUser(args []string, stdout, stderr io.Writer) int {
	if len(args) == 0 || args[0] == "-h" || args[0] == "--help" {
		fmt.Fprintln(stdout, "用法：factorybridge user <create|list|passwd|role|unlock|disable|enable|delete> [参数]")
		fmt.Fprintln(stdout, "  create  --name 用户名 [--role viewer|operator|engineer|admin]  口令交互输入，不回显")
		fmt.Fprintln(stdout, "  list")
		fmt.Fprintln(stdout, "  passwd  --name 用户名                 重置口令，用户下次登录须修改")
		fmt.Fprintln(stdout, "  role    --name 用户名 --role 角色")
		fmt.Fprintln(stdout, "  unlock|disable|enable|delete --name 用户名")
		fmt.Fprintln(stdout, "通用参数：--data-dir 数据目录；--password-stdin 从标准输入读口令（脚本用）")
		if len(args) == 0 {
			return exitUsage
		}
		return exitOK
	}
	sub, rest := args[0], args[1:]
	// 先校验子命令，未知子命令不打开（也不新建）数据库。
	switch sub {
	case "list", "create", "passwd", "role", "disable", "enable", "unlock", "delete":
	default:
		fmt.Fprintf(stderr, "未知子命令 user %s\n", sub)
		return exitUsage
	}
	fs := flag.NewFlagSet("user "+sub, flag.ContinueOnError)
	fs.SetOutput(stderr)
	dataDir := fs.String("data-dir", envOr("GATEWAY_GO_DATA_DIR", defaultDataDir()), "数据目录")
	name := fs.String("name", "", "用户名")
	role := fs.String("role", "", "角色 viewer|operator|engineer|admin")
	passwordStdin := fs.Bool("password-stdin", false, "从标准输入读取口令")
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
	store, database, err := openUserStore(ctx, *dataDir, stderr)
	if err != nil {
		fmt.Fprintf(stderr, "打开用户库失败：%v\n", err)
		return exitConfig
	}
	defer database.Close()

	if sub == "list" {
		users, err := store.ListUsers(ctx)
		if err != nil {
			fmt.Fprintln(stderr, err)
			return exitError
		}
		fmt.Fprintf(stdout, "%-24s %-10s %-8s %s\n", "USERNAME", "ROLE", "STATE", "ID")
		for _, u := range users {
			state := "active"
			if u.Disabled {
				state = "disabled"
			} else if u.MustChangePassword {
				state = "pending"
			}
			fmt.Fprintf(stdout, "%-24s %-10s %-8s %s\n", u.Username, u.Role, state, u.ID)
		}
		return exitOK
	}
	if *name == "" {
		fmt.Fprintln(stderr, "缺少 --name")
		return exitUsage
	}
	readPassword := func(prompt string) (string, bool) {
		password, err := readSecret(prompt, *passwordStdin, stderr)
		if err != nil {
			fmt.Fprintf(stderr, "读取口令失败：%v\n", err)
			return "", false
		}
		if err := auth.ValidatePassword(password); err != nil {
			fmt.Fprintln(stderr, err)
			return "", false
		}
		return password, true
	}
	if sub == "create" {
		r := auth.Role(*role)
		if r == "" {
			r = auth.RoleViewer
		}
		if !auth.ValidRole(r) {
			fmt.Fprintf(stderr, "无效角色 %q\n", r)
			return exitUsage
		}
		password, ok := readPassword(fmt.Sprintf("为 %s 设置口令：", *name))
		if !ok {
			return exitUsage
		}
		// 命令行创建的账号由操作者本人设置口令，不强制首次改密
		user, err := store.CreateUser(ctx, *name, password, r, false)
		if err != nil {
			fmt.Fprintln(stderr, err)
			if errors.Is(err, auth.ErrUserExists) {
				return exitUsage
			}
			return exitError
		}
		fmt.Fprintf(stdout, "已创建用户 %s（%s）\n", user.Username, user.Role)
		return exitOK
	}
	user, err := store.GetUserByName(ctx, *name)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return exitUsage
	}
	var patch auth.UserPatch
	switch sub {
	case "passwd":
		password, ok := readPassword(fmt.Sprintf("%s 的新口令：", user.Username))
		if !ok {
			return exitUsage
		}
		patch.Password = &password
	case "role":
		r := auth.Role(*role)
		if !auth.ValidRole(r) {
			fmt.Fprintf(stderr, "无效角色 %q\n", *role)
			return exitUsage
		}
		patch.Role = &r
	case "disable", "enable":
		disabled := sub == "disable"
		patch.Disabled = &disabled
	case "unlock":
		if err := store.Unlock(ctx, user.ID); err != nil {
			fmt.Fprintln(stderr, err)
			return exitError
		}
		fmt.Fprintf(stdout, "已解锁 %s\n", user.Username)
		return exitOK
	case "delete":
		if err := store.DeleteUser(ctx, user.ID); err != nil {
			fmt.Fprintln(stderr, err)
			return exitError
		}
		fmt.Fprintf(stdout, "已删除 %s\n", user.Username)
		return exitOK
	default:
		fmt.Fprintf(stderr, "未知子命令 user %s\n", sub)
		return exitUsage
	}
	if _, err := store.UpdateUser(ctx, user.ID, patch); err != nil {
		fmt.Fprintln(stderr, err)
		return exitError
	}
	fmt.Fprintf(stdout, "已更新 %s；该用户现有会话已失效\n", user.Username)
	return exitOK
}

// readSecret 交互输入时关闭回显并要求确认；--password-stdin 时读取标准输入第一行。
func readSecret(prompt string, fromStdin bool, stderr io.Writer) (string, error) {
	if fromStdin {
		line, err := bufio.NewReader(os.Stdin).ReadString('\n')
		if err != nil && !errors.Is(err, io.EOF) {
			return "", err
		}
		return strings.TrimRight(line, "\r\n"), nil
	}
	fd := int(os.Stdin.Fd())
	if !term.IsTerminal(fd) {
		return "", fmt.Errorf("标准输入不是终端；脚本中请使用 --password-stdin")
	}
	fmt.Fprint(stderr, prompt)
	first, err := term.ReadPassword(fd)
	fmt.Fprintln(stderr)
	if err != nil {
		return "", err
	}
	fmt.Fprint(stderr, "再次输入：")
	second, err := term.ReadPassword(fd)
	fmt.Fprintln(stderr)
	if err != nil {
		return "", err
	}
	if string(first) != string(second) {
		return "", fmt.Errorf("两次输入不一致")
	}
	return string(first), nil
}

// ensureDevAccount 在开发模式下保证存在账号 dev（admin）。未通过 FB_DEV_PASSWORD 指定口令时，
// 每次启动生成随机口令并打印到日志；已存在时重置为本次口令，开发者不必记住上次的值。
func ensureDevAccount(ctx context.Context, store *auth.UserStore, password string, logger *slog.Logger) error {
	generated := password == ""
	if generated {
		buf := make([]byte, 12)
		if _, err := rand.Read(buf); err != nil {
			return err
		}
		// 满足口令策略：大小写、数字、特殊字符各至少一个
		password = "Dev-" + base64.RawURLEncoding.EncodeToString(buf) + "-9a"
	}
	if err := auth.ValidatePassword(password); err != nil {
		return fmt.Errorf("FB_DEV_PASSWORD: %w", err)
	}
	user, err := store.GetUserByName(ctx, "dev")
	switch {
	case errors.Is(err, auth.ErrUserNotFound):
		if _, err := store.CreateUser(ctx, "dev", password, auth.RoleAdmin, false); err != nil {
			return err
		}
	case err != nil:
		return err
	default:
		if err := store.SetPassword(ctx, user.ID, password); err != nil {
			return err
		}
	}
	if generated {
		logger.Warn("development account", "username", "dev", "password", password)
	} else {
		logger.Warn("development account", "username", "dev", "password", "(from FB_DEV_PASSWORD)")
	}
	return nil
}
