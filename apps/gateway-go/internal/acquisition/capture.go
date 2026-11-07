package acquisition

import (
	"encoding/hex"
	"net"
	"sync"
	"time"
)

// 报文抓包（FR-M2-20）：每个通道保留最近 frameRingSize 帧（TX/RX），供控制台诊断面板查看。
//
// 实现方式是包装驱动拨号得到的 net.Conn：Write 记 TX、Read 记 RX，各协议驱动只需把
// net.DialTimeout 换成 dialCaptured，不改报文处理逻辑。单帧超过 frameMaxBytes 时截断。
// 读取可能被 io.ReadFull 拆成多次（如先读头部再读正文），每次 Read 记为一条 RX，与线上字节一致。

const (
	frameRingSize = 200
	frameMaxBytes = 512
)

type Frame struct {
	TS    int64  `json:"ts"`
	Dir   string `json:"dir"`
	Hex   string `json:"hex"`
	Bytes int    `json:"bytes"`
	Note  string `json:"note,omitempty"`
}

type frameRing struct {
	mu     sync.Mutex
	frames []Frame
	next   int
	full   bool
}

var captures sync.Map // channelID -> *frameRing

func ringFor(channelID string) *frameRing {
	if v, ok := captures.Load(channelID); ok {
		return v.(*frameRing)
	}
	v, _ := captures.LoadOrStore(channelID, &frameRing{frames: make([]Frame, frameRingSize)})
	return v.(*frameRing)
}

func recordFrame(channelID, dir string, data []byte) {
	if channelID == "" || len(data) == 0 {
		return
	}
	n := len(data)
	shown := data
	note := ""
	if n > frameMaxBytes {
		shown, note = data[:frameMaxBytes], "truncated"
	}
	ring := ringFor(channelID)
	ring.mu.Lock()
	ring.frames[ring.next] = Frame{TS: time.Now().UnixMilli(), Dir: dir, Hex: hex.EncodeToString(shown), Bytes: n, Note: note}
	ring.next = (ring.next + 1) % frameRingSize
	if ring.next == 0 {
		ring.full = true
	}
	ring.mu.Unlock()
}

// Frames 返回通道最近的帧（新的在前）；dir 为 "TX"/"RX" 时过滤。
func Frames(channelID string, limit int, dir string) []Frame {
	v, ok := captures.Load(channelID)
	if !ok {
		return []Frame{}
	}
	ring := v.(*frameRing)
	ring.mu.Lock()
	defer ring.mu.Unlock()
	count := ring.next
	if ring.full {
		count = frameRingSize
	}
	out := make([]Frame, 0, min(limit, count))
	for i := 0; i < count && len(out) < limit; i++ {
		frame := ring.frames[(ring.next-1-i+frameRingSize)%frameRingSize]
		if dir == "" || frame.Dir == dir {
			out = append(out, frame)
		}
	}
	return out
}

// ClearFrames 清空通道的抓包缓冲。
func ClearFrames(channelID string) { captures.Delete(channelID) }

type capturedConn struct {
	net.Conn
	channelID string
}

func (c capturedConn) Write(p []byte) (int, error) {
	n, err := c.Conn.Write(p)
	recordFrame(c.channelID, "TX", p[:n])
	return n, err
}

func (c capturedConn) Read(p []byte) (int, error) {
	n, err := c.Conn.Read(p)
	recordFrame(c.channelID, "RX", p[:n])
	return n, err
}

// dialCaptured 与 net.DialTimeout 相同，返回的连接会记录收发报文。
func dialCaptured(channelID, network, address string, timeout time.Duration) (net.Conn, error) {
	conn, err := net.DialTimeout(network, address, timeout)
	if err != nil {
		return nil, err
	}
	return capturedConn{Conn: conn, channelID: channelID}, nil
}
