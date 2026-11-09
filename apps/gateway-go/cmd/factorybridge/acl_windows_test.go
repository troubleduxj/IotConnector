//go:build windows

package main

import (
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"strings"
	"testing"
)

// 不需要管理员权限：在临时目录上执行同样的 icacls（用当前用户代替服务虚拟账号），检查：
//   - 目录断开继承，只剩 SYSTEM、Administrators 与服务账号；
//   - 已有文件（含子目录里的）改为只继承这三方，且服务账号仍能读；
//   - 之后新建的文件也只继承这三方；
//   - 空目录不报错。
func TestRestrictDataDirRemovesInheritedAccess(t *testing.T) {
	current, err := user.Current()
	if err != nil {
		t.Fatal(err)
	}
	dir := filepath.Join(t.TempDir(), "data")
	// 收紧后目录不再继承上级权限，t.TempDir 的清理会被拒绝；先恢复继承再删除。
	t.Cleanup(func() { _ = exec.Command("icacls", dir, "/reset", "/T", "/C", "/Q").Run() })
	if err := os.MkdirAll(filepath.Join(dir, "tls"), 0o750); err != nil {
		t.Fatal(err)
	}
	existing := filepath.Join(dir, "config.json")
	nested := filepath.Join(dir, "tls", "selfsigned.key")
	for _, path := range []string{existing, nested} {
		if err := os.WriteFile(path, []byte("{}"), 0o640); err != nil {
			t.Fatal(err)
		}
	}
	if err := restrictDataDir(dir, current.Username); err != nil {
		t.Fatal(err)
	}
	created := filepath.Join(dir, "gateway.db")
	if err := os.WriteFile(created, []byte("x"), 0o640); err != nil {
		t.Fatalf("service account can no longer write: %v", err)
	}
	if b, err := os.ReadFile(existing); err != nil || string(b) != "{}" {
		t.Fatalf("existing file unreadable after restricting: %v", err)
	}

	dirACL := acl(t, dir)
	if strings.Contains(dirACL, "(I)") {
		t.Fatalf("data dir still has inherited entries:\n%s", dirACL)
	}
	for _, path := range []string{dir, existing, nested, created} {
		got := acl(t, path)
		if !strings.Contains(got, current.Username) {
			t.Fatalf("%s lost the service account grant:\n%s", path, got)
		}
		if n := aclEntries(got); n != 3 {
			t.Fatalf("%s has %d entries, want 3 (SYSTEM, Administrators, service account):\n%s", path, n, got)
		}
	}

	empty := filepath.Join(t.TempDir(), "empty")
	t.Cleanup(func() { _ = exec.Command("icacls", empty, "/reset", "/T", "/C", "/Q").Run() })
	if err := restrictDataDir(empty, current.Username); err != nil {
		t.Fatalf("empty data dir: %v", err)
	}
}

func acl(t *testing.T, path string) string {
	t.Helper()
	out, err := exec.Command("icacls", path).CombinedOutput()
	if err != nil {
		t.Fatalf("icacls %s: %v %s", path, err, out)
	}
	return string(out)
}

// aclEntries 数 icacls 输出中的权限条目（形如 名称:(...)），与系统语言无关。
func aclEntries(out string) int {
	n := 0
	for _, line := range strings.Split(out, "\n") {
		if strings.Contains(line, ":(") {
			n++
		}
	}
	return n
}
