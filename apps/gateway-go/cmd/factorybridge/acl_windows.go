//go:build windows

package main

import (
	"fmt"
	"os"
	"os/exec"
	"strings"
)

// 数据目录权限（Windows）。
//
// 原实现只用 icacls /grant 给服务账号追加修改权限，目录仍继承上级的 ACL。常见位置（如 D:\ 下）
// 会继承 Authenticated Users:修改 与 Users:读取，本机任何登录用户都能读写 gateway.db 和
// 含明文口令的 config.json（2026-11-09 实测发现）。
//
// 现在：断开继承、去掉继承来的条目，只显式授予三方，并以 (OI)(CI) 让之后新建的文件
// （gateway.db、config.json、tls/selfsigned.key 等）继承同样的三条：
//   - SYSTEM（S-1-5-18）与 Administrators（S-1-5-32-544）：完全控制，便于运维与备份；
//   - 服务虚拟账号：修改。
// 用 SID 而不是名称，避免非英文 Windows 上组名不同导致失败。

const (
	sidSystem         = "*S-1-5-18"
	sidAdministrators = "*S-1-5-32-544"
)

// dataDirACLArgs 返回收紧数据目录权限的 icacls 调用（不含程序名），按顺序执行。
//
// 顺序很重要（2026-11-09 实测）：若一次调用里用 /T 同时 /inheritance:r，已有文件会先被
// 删掉继承来的条目、再从父目录继承时父目录还没授权完，结果已有文件的 ACL 变成空的，
// 连服务账号也打不开 gateway.db。所以分两步：
//  1. 只在目录本身显式授予三方并断开继承（不加 /T）；
//  2. 对目录下已有子项 /reset：清掉它们的显式 ACL，改为从（已收紧的）目录继承。
func dataDirACLArgs(dataDir, account string) [][]string {
	return [][]string{
		{dataDir, "/inheritance:r",
			"/grant:r", sidSystem + ":(OI)(CI)F",
			"/grant:r", sidAdministrators + ":(OI)(CI)F",
			"/grant:r", account + ":(OI)(CI)M",
			"/C", "/Q"},
		{dataDir + `\*`, "/reset", "/T", "/C", "/Q"},
	}
}

// restrictDataDir 创建（如不存在）并收紧数据目录权限。
func restrictDataDir(dataDir, account string) error {
	if err := os.MkdirAll(dataDir, 0o750); err != nil {
		return fmt.Errorf("创建数据目录 %s：%w", dataDir, err)
	}
	for i, args := range dataDirACLArgs(dataDir, account) {
		out, err := exec.Command("icacls", args...).CombinedOutput()
		// 第二步在空目录上会因为通配符没有匹配而失败，这是正常情况。
		if err != nil && i == 1 && isEmptyDir(dataDir) {
			continue
		}
		if err != nil {
			return fmt.Errorf("icacls %s：%v\n%s", strings.Join(args, " "), err, out)
		}
	}
	return nil
}

func isEmptyDir(dir string) bool {
	entries, err := os.ReadDir(dir)
	return err == nil && len(entries) == 0
}
