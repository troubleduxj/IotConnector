package scriptworker

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"runtime/debug"
	"runtime/metrics"
	"strings"
	"sync/atomic"
	"time"

	"github.com/dop251/goja"
)

const (
	maxRequestBytes    = 256 * 1024
	maxCodeBytes       = 64 * 1024
	maxOutputBytes     = 64 * 1024
	maxOutputLineBytes = 2 * 1024
	maxWrites          = 50
	maxWriteValueBytes = 4 * 1024

	memoryExitCode = 3
	heapPollEvery  = 10 * time.Millisecond
)

const memoryLimitMessage = "script memory limit exceeded"

// 内存上限（B8）。goja 没有内存配额，由看门狗按堆占用判断：
// 超过 maxHeapBytes 时中断脚本；中断要等到下一条 JS 指令才生效，
// 单次巨大分配（如 'x'.repeat(1e9)）来不及中断，超过 hardHeapBytes 时直接退出子进程。
// 用变量而非常量，测试可调低以免受机器速度影响。
var (
	maxHeapBytes  uint64 = 64 << 20
	hardHeapBytes uint64 = 128 << 20
)

// heapBytes 返回当前堆上对象占用的字节数。
func heapBytes() uint64 {
	sample := []metrics.Sample{{Name: "/memory/classes/heap/objects:bytes"}}
	metrics.Read(sample)
	if sample[0].Value.Kind() != metrics.KindUint64 {
		return 0
	}
	return sample[0].Value.Uint64()
}

// watchHeap 周期检查堆占用，返回停止函数。
func watchHeap(interrupt func(), exceeded *atomic.Bool) func() {
	done := make(chan struct{})
	go func() {
		ticker := time.NewTicker(heapPollEvery)
		defer ticker.Stop()
		for {
			select {
			case <-done:
				return
			case <-ticker.C:
				used := heapBytes()
				if used > hardHeapBytes {
					fmt.Fprintln(os.Stderr, memoryLimitMessage)
					os.Exit(memoryExitCode)
				}
				if used > maxHeapBytes && !exceeded.Swap(true) {
					interrupt()
				}
			}
		}
	}()
	return func() { close(done) }
}

type Request struct {
	Code   string            `json:"code"`
	Values map[string]any    `json:"values"`
	Tags   map[string]string `json:"tags"`
}

type Write struct {
	TagID string `json:"tagId"`
	Value any    `json:"value"`
}
type Response struct {
	OK         bool     `json:"ok"`
	Outputs    []string `json:"outputs"`
	Writes     []Write  `json:"writes"`
	Error      string   `json:"error,omitempty"`
	DurationMs int64    `json:"durationMs"`
}

func Run() error {
	input, err := io.ReadAll(io.LimitReader(os.Stdin, maxRequestBytes+1))
	if err != nil {
		return err
	}
	if len(input) > maxRequestBytes {
		return fmt.Errorf("script request exceeds %d bytes", maxRequestBytes)
	}
	var request Request
	if err := json.Unmarshal(input, &request); err != nil {
		return err
	}
	if len([]byte(request.Code)) > maxCodeBytes {
		return fmt.Errorf("script code exceeds %d bytes", maxCodeBytes)
	}
	// 让 GC 在接近上限时更积极回收，减少误判。
	debug.SetMemoryLimit(int64(maxHeapBytes))
	start := time.Now()
	runtime := goja.New()
	outputs := []string{}
	outputBytes := 0
	writes := []Write{}
	appendOutput := func(value string) {
		if len(outputs) >= 50 || outputBytes >= maxOutputBytes {
			return
		}
		if len([]byte(value)) > maxOutputLineBytes {
			value = string([]byte(value)[:maxOutputLineBytes]) + "..."
		}
		remaining := maxOutputBytes - outputBytes
		if len([]byte(value)) > remaining {
			value = string([]byte(value)[:remaining])
		}
		if value == "" {
			return
		}
		outputs = append(outputs, value)
		outputBytes += len([]byte(value))
	}
	read := func(key string) any {
		value, ok := request.Values[key]
		if !ok {
			panic(runtime.ToValue("Read: tag has no value"))
		}
		return value
	}
	runtime.Set("Read", read)
	runtime.Set("Write", func(key string, value any) {
		tagID, ok := request.Tags[key]
		if !ok {
			panic(runtime.ToValue("Write: tag not found"))
		}
		if len(writes) >= maxWrites {
			panic(runtime.ToValue("Write: too many writes"))
		}
		encoded, err := json.Marshal(value)
		if err != nil || len(encoded) > maxWriteValueBytes {
			panic(runtime.ToValue("Write: value exceeds resource limit"))
		}
		writes = append(writes, Write{TagID: tagID, Value: value})
		appendOutput(fmt.Sprintf("Write %s = %v", key, value))
	})
	logFn := func(args ...any) {
		parts := make([]string, len(args))
		for i, arg := range args {
			parts[i] = fmt.Sprint(arg)
		}
		appendOutput(strings.Join(parts, " "))
	}
	runtime.Set("log", logFn)
	runtime.Set("console", map[string]any{"log": logFn})
	timer := time.AfterFunc(time.Second, func() { runtime.Interrupt("script timeout") })
	var overLimit atomic.Bool
	stopWatch := watchHeap(func() { runtime.Interrupt(memoryLimitMessage) }, &overLimit)
	_, runErr := runtime.RunString(request.Code)
	stopWatch()
	timer.Stop()
	response := Response{OK: runErr == nil, Outputs: outputs, Writes: writes, DurationMs: time.Since(start).Milliseconds()}
	if runErr != nil {
		response.Error = runErr.Error()
		if overLimit.Load() {
			response.Error = memoryLimitMessage
			response.Writes = nil // 超限中断的脚本不执行写值
		}
	}
	return json.NewEncoder(os.Stdout).Encode(response)
}
