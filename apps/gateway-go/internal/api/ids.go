package api

import (
	"crypto/rand"
	"encoding/base64"
)

// newID 生成带前缀的随机 ID（72 位随机数）。
//
// 原实现用 fmt.Sprintf("x_%d", time.Now().UnixNano()/UnixMilli())：Windows 时钟粒度粗，
// 同一刻生成的两个 ID 相同。告警事件按 ID 持久化后，碰撞会让后一条覆盖前一条；
// 配方、脚本、存储任务在同一毫秒内创建两条时也会撞 ID（Node 网关 D13 的同类问题）。
func newID(prefix string) string {
	buf := make([]byte, 9)
	_, _ = rand.Read(buf)
	return prefix + base64.RawURLEncoding.EncodeToString(buf)
}
