package api

import (
	"github.com/factorybridge/iotconnector/gateway-go/internal/acquisition"
	"github.com/factorybridge/iotconnector/gateway-go/internal/config"
	"github.com/factorybridge/iotconnector/gateway-go/internal/domain"
	"github.com/factorybridge/iotconnector/gateway-go/internal/storage"
)

// 运行时与 HTTP 层分离（F6）。
//
// 原先 api.Server 既处理 HTTP，又在 engine.SetOnSample 回调里直接驱动历史、时序库、
// 告警、存储任务、脚本、北向、影子和实时推送；脚本与存储任务引擎也持有整个 *Server。
// 现在：
//   - Runtime 负责把每个采集样本分发给各运行时组件，分发顺序集中在 onSample 一处；
//   - 脚本与存储任务引擎只依赖 runtimeHost 接口（读配置、写配置、读写位号、时序库），
//     不能再触及 HTTP、鉴权、会话等无关状态。
// 对外行为与 API 不变。

// runtimeHost 是脚本与存储任务引擎对宿主的全部依赖。
type runtimeHost interface {
	cfg() *config.Config
	// commitRawLocked 替换配置中的一个顶层键并保存；调用方须先 lockConfig。
	commitRawLocked(key string, value any) error
	lockConfig()
	unlockConfig()
	acquisition() *acquisition.Engine
	storageWriter() *storage.Writer
	storageDB() string
	storageTasksSnapshot() []map[string]any
}

func (s *Server) lockConfig()                      { s.configMu.Lock() }
func (s *Server) unlockConfig()                    { s.configMu.Unlock() }
func (s *Server) acquisition() *acquisition.Engine { return s.engine }
func (s *Server) storageWriter() *storage.Writer   { return s.storage }

// Runtime 分发采集样本。各组件为 nil 时跳过（测试与精简部署）。
type Runtime struct {
	server *Server
}

// onSample 是采集引擎的样本回调。顺序与拆分前一致：
// 历史 → 时序库 → 存储任务 → 北向 → 脚本 → 影子 → 告警 → 实时推送。
func (rt *Runtime) onSample(sample acquisition.Sample) {
	s := rt.server
	s.historyStore.add(sample)
	tag, known := rt.tag(sample.TagID)
	if s.storage != nil && known {
		s.storage.Enqueue(acquisition.Tag{ID: tag.ID, Name: tag.Name, ChannelID: tag.ChannelID, DataType: tag.DataType}, sample)
	}
	if s.taskEngine != nil {
		s.taskEngine.onSample(sample)
		s.taskEngine.onBoolSample(sample)
	}
	if s.northboundPublisher != nil {
		s.northboundPublisher.PublishSample(sample)
	}
	if s.scriptEngine != nil {
		s.scriptEngine.onSample(sample)
	}
	s.shadowStore.SetReported(sample.TagID, wireValue(sample.Value), string(sample.Quality), sample.SampledAt)
	s.scheduleShadowPublish()
	if known {
		s.alarms.evaluate(tag, sample)
	}
	s.liveBatch.add(sample) // 每 100ms 合并推送一次（C7）
}

// tag 按 ID 查当前配置中的位号。原实现在时序库和告警两处各扫一遍，这里只扫一次。
func (rt *Runtime) tag(id string) (domain.Tag, bool) {
	for _, tag := range rt.server.cfg().Tags {
		if tag.ID == id {
			return tag, true
		}
	}
	return domain.Tag{}, false
}
