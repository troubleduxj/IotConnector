package main

import (
	"database/sql"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/factorybridge/iotconnector/gateway-go/internal/db"
)

// 默认数据目录（A4）。
//
// 早期 Go 网关与 Node 网关共用 apps/gateway/data，两套状态文件混在一起，
// 回滚或对比时互相覆盖。现在 Go 网关默认使用自己的目录：
//   - 在仓库根或 apps/gateway-go 下运行：apps/gateway-go/data
//   - 其它位置（发布包）：可执行文件旁的 data/
//
// 首次以默认目录启动、且新目录里还没有 config.json 和 gateway.db 时，
// 从旧目录 apps/gateway/data 复制一份状态过来（只复制，不移动，旧目录保持原样）。
// 显式指定 --data-dir 或 GATEWAY_GO_DATA_DIR 时不做任何导入。

const legacyNodeDataDir = "apps/gateway/data"

// defaultDataDir 返回未显式指定时使用的数据目录。
func defaultDataDir() string {
	if isDir(filepath.Join("apps", "gateway-go")) {
		return filepath.Join("apps", "gateway-go", "data")
	}
	if isFile("go.mod") && isDir(filepath.Join("cmd", "factorybridge")) {
		return "data"
	}
	if exe, err := os.Executable(); err == nil {
		return filepath.Join(filepath.Dir(exe), "data")
	}
	return "data"
}

// legacyDataDirFor 返回与默认数据目录对应的旧 Node 数据目录；不在仓库里时返回空串。
func legacyDataDirFor(dataDir string) string {
	switch filepath.Clean(dataDir) {
	case filepath.Join("apps", "gateway-go", "data"):
		return filepath.FromSlash(legacyNodeDataDir)
	case "data":
		if isFile("go.mod") {
			return filepath.Join("..", "gateway", "data")
		}
	}
	return ""
}

// resolveDataDir 处理 --data-dir/GATEWAY_GO_DATA_DIR 未指定的情况：
// explicit 为 true 时原样返回；否则在需要时从旧目录导入。
func resolveDataDir(dataDir string, explicit bool, log io.Writer) (string, error) {
	if explicit {
		return dataDir, nil
	}
	legacy := legacyDataDirFor(dataDir)
	if legacy == "" {
		return dataDir, nil
	}
	if err := importLegacyDataDir(legacy, dataDir, log); err != nil {
		return "", fmt.Errorf("从 %s 导入状态失败：%w（可用 --data-dir 显式指定目录跳过导入）", legacy, err)
	}
	return dataDir, nil
}

// dataDirFlag 解析 --data-dir 后调用：未显式指定时按需从旧目录导入。
func dataDirFlag(fs *flag.FlagSet, value string, log io.Writer) (string, error) {
	explicit := os.Getenv("GATEWAY_GO_DATA_DIR") != ""
	fs.Visit(func(f *flag.Flag) {
		if f.Name == "data-dir" {
			explicit = true
		}
	})
	return resolveDataDir(value, explicit, log)
}

// importLegacyDataDir 在 dst 尚无状态时把 src 的状态复制过去。
// gateway.db 用 VACUUM INTO 复制，得到一致的快照，即使旧网关仍在运行。
func importLegacyDataDir(src, dst string, log io.Writer) error {
	if isFile(filepath.Join(dst, "config.json")) || isFile(filepath.Join(dst, db.FileName)) {
		return nil
	}
	if !isFile(filepath.Join(src, "config.json")) && !isFile(filepath.Join(src, db.FileName)) {
		return nil
	}
	if err := os.MkdirAll(dst, 0o750); err != nil {
		return err
	}
	var copied []string
	if isFile(filepath.Join(src, db.FileName)) {
		if err := snapshotSQLite(filepath.Join(src, db.FileName), filepath.Join(dst, db.FileName)); err != nil {
			return err
		}
		copied = append(copied, db.FileName)
	}
	// config.json 与尚未导入 SQLite 的旧状态文件；*.migrated 已在库里，不复制。
	files := append([]string{"config.json"}, legacyFiles...)
	parts, _ := filepath.Glob(filepath.Join(src, "outbox.json.part-*"))
	for _, part := range parts {
		if !strings.HasSuffix(part, ".migrated") {
			files = append(files, filepath.Base(part))
		}
	}
	for _, name := range files {
		from := filepath.Join(src, name)
		if !isFile(from) {
			continue
		}
		if err := copyFile(from, filepath.Join(dst, name)); err != nil {
			return err
		}
		copied = append(copied, name)
	}
	if tlsDir := filepath.Join(src, "tls"); isDir(tlsDir) {
		for _, name := range []string{"selfsigned.crt", "selfsigned.key"} {
			if isFile(filepath.Join(tlsDir, name)) {
				if err := os.MkdirAll(filepath.Join(dst, "tls"), 0o700); err != nil {
					return err
				}
				if err := copyFile(filepath.Join(tlsDir, name), filepath.Join(dst, "tls", name)); err != nil {
					return err
				}
				copied = append(copied, "tls/"+name)
			}
		}
	}
	fmt.Fprintf(log, "数据目录 %s 为空，已从旧目录 %s 复制：%s（旧目录未改动）\n", dst, src, strings.Join(copied, ", "))
	return nil
}

func snapshotSQLite(src, dst string) error {
	conn, err := sql.Open("sqlite", "file:"+filepath.ToSlash(src)+"?mode=ro&_pragma=busy_timeout(5000)")
	if err != nil {
		return err
	}
	defer conn.Close()
	if _, err := conn.Exec("VACUUM INTO ?", dst); err != nil {
		_ = os.Remove(dst)
		return fmt.Errorf("快照 %s：%w", src, err)
	}
	_ = os.Chmod(dst, 0o640)
	return nil
}

func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	info, err := in.Stat()
	if err != nil {
		return err
	}
	tmp := dst + ".importing"
	out, err := os.OpenFile(tmp, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, info.Mode().Perm())
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		_ = os.Remove(tmp)
		return err
	}
	if err := out.Close(); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return os.Rename(tmp, dst)
}

func isFile(path string) bool {
	info, err := os.Stat(path)
	return err == nil && info.Mode().IsRegular()
}

func isDir(path string) bool {
	info, err := os.Stat(path)
	return err == nil && info.IsDir()
}
