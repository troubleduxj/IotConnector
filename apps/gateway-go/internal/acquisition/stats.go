package acquisition

import "time"

// 通道级通讯统计（C11）。调度页需要每通道的采样数、速率、错误数与平均周期；
// 原实现返回全 0 占位。驱动通过 publish 上报样本、通过 setStatus 上报状态与延迟，
// 这里在两处挂钩累计，不需要改各协议驱动。

type channelStats struct {
	samples      uint64
	errors       uint64
	cycles       uint64
	latencyTotal uint64
	lastSampleAt int64
	// 速率：最近一个窗口的样本数，窗口约 5 秒滚动一次，避免瞬时值抖动
	windowStart   time.Time
	windowSamples uint64
	rateHz        float64
}

// ChannelStats 是对外暴露的统计快照。
type ChannelStats struct {
	Samples      uint64  `json:"samples"`
	RateHz       float64 `json:"rateHz"`
	Errors       uint64  `json:"err"`
	Cycles       uint64  `json:"rx"`
	AvgCycleMs   float64 `json:"avgCycleMs"`
	LastSampleAt int64   `json:"lastCommAt,omitempty"`
}

const rateWindow = 5 * time.Second

func (e *Engine) statsFor(channelID string) *channelStats {
	if e.stats == nil {
		e.stats = map[string]*channelStats{}
	}
	st := e.stats[channelID]
	if st == nil {
		st = &channelStats{windowStart: time.Now()}
		e.stats[channelID] = st
	}
	return st
}

// recordSampleLocked 在 publish 中调用（已持有 e.mu）。
func (e *Engine) recordSampleLocked(tagID string, at int64) {
	channelID := e.tagChannel[tagID]
	if channelID == "" {
		return
	}
	st := e.statsFor(channelID)
	st.samples++
	st.windowSamples++
	st.lastSampleAt = at
	e.rollWindowLocked(st, time.Now())
}

func (e *Engine) rollWindowLocked(st *channelStats, now time.Time) {
	elapsed := now.Sub(st.windowStart)
	if elapsed < rateWindow {
		return
	}
	st.rateHz = float64(st.windowSamples) / elapsed.Seconds()
	st.windowSamples = 0
	st.windowStart = now
}

// recordStatusLocked 在 setStatus 中调用（已持有 e.mu）。进入 offline/error 计一次错误；
// 状态详情带延迟（"OK 12ms"）时计一次成功周期。
func (e *Engine) recordStatusLocked(status ChannelStatus, previous string, latencyMs int64, hasLatency bool) {
	st := e.statsFor(status.ID)
	if (status.State == "offline" || status.State == "error") && previous != status.State {
		st.errors++
	}
	if hasLatency {
		st.cycles++
		st.latencyTotal += uint64(latencyMs)
	}
}

// ChannelStats 返回各通道统计。长时间没有样本的通道，速率按已过时间衰减到 0，
// 而不是停留在最后一个窗口的值。
func (e *Engine) ChannelStats() map[string]ChannelStats {
	e.mu.Lock()
	defer e.mu.Unlock()
	now := time.Now()
	out := make(map[string]ChannelStats, len(e.stats))
	for id, st := range e.stats {
		e.rollWindowLocked(st, now)
		rate := st.rateHz
		if st.lastSampleAt > 0 && now.Sub(time.UnixMilli(st.lastSampleAt)) > 2*rateWindow {
			rate = 0
		}
		avg := 0.0
		if st.cycles > 0 {
			avg = float64(st.latencyTotal) / float64(st.cycles)
		}
		out[id] = ChannelStats{Samples: st.samples, RateHz: rate, Errors: st.errors, Cycles: st.cycles, AvgCycleMs: avg, LastSampleAt: st.lastSampleAt}
	}
	return out
}

func buildTagChannel(tags []Tag) map[string]string {
	m := make(map[string]string, len(tags))
	for _, tag := range tags {
		m[tag.ID] = tag.ChannelID
	}
	return m
}
