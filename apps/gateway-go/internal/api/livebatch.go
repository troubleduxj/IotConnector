package api

import (
	"sync"
	"time"

	"github.com/factorybridge/iotconnector/gateway-go/internal/acquisition"
)

// sampleBatcher 合并实时样本推送（C7）。
//
// 原实现每个样本单独广播一条 tags-batch 消息：37 个位号、1 秒周期就是每秒 37 条消息，
// 客户端 32 条的发送缓冲在页面卡顿时很快被填满，后续消息被静默丢弃。
// 现在每 liveBatchInterval 把这段时间内的样本合并成一条消息；同一位号只保留最新值。
const liveBatchInterval = 100 * time.Millisecond

type sampleBatcher struct {
	hub     *wsHub
	mu      sync.Mutex
	pending map[string]acquisition.Sample
	order   []string
	timer   *time.Timer
	stopped bool
}

func newSampleBatcher(hub *wsHub) *sampleBatcher {
	return &sampleBatcher{hub: hub, pending: map[string]acquisition.Sample{}}
}

func (b *sampleBatcher) add(sample acquisition.Sample) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.stopped {
		return
	}
	if _, seen := b.pending[sample.TagID]; !seen {
		b.order = append(b.order, sample.TagID)
	}
	b.pending[sample.TagID] = sample
	if b.timer == nil {
		b.timer = time.AfterFunc(liveBatchInterval, b.flush)
	}
}

func (b *sampleBatcher) flush() {
	b.mu.Lock()
	samples := make([]acquisition.Sample, 0, len(b.order))
	for _, id := range b.order {
		samples = append(samples, b.pending[id])
	}
	b.pending = map[string]acquisition.Sample{}
	b.order = nil
	b.timer = nil
	b.mu.Unlock()
	if len(samples) > 0 {
		b.hub.broadcast(map[string]any{"type": "tags-batch", "values": wireSamples(samples)}, true)
	}
}

func (b *sampleBatcher) stop() {
	if b == nil {
		return
	}
	b.mu.Lock()
	b.stopped = true
	if b.timer != nil {
		b.timer.Stop()
		b.timer = nil
	}
	b.mu.Unlock()
}
