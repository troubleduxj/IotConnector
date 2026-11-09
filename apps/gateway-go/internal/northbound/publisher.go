package northbound

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/eclipse/paho.mqtt.golang"
	"github.com/factorybridge/iotconnector/gateway-go/internal/acquisition"
	"github.com/factorybridge/iotconnector/gateway-go/internal/db"
)

type Config struct {
	Enabled                                      bool
	URL, Username, Password, GroupID, EdgeNodeID string
	DataFlushMs                                  int
}
type Status struct {
	Connected     bool   `json:"connected"`
	BDSeq         uint64 `json:"bdSeq"`
	Seq           uint64 `json:"seq"`
	Queued        int    `json:"queued"`
	Dropped       int    `json:"dropped"`
	Published     int    `json:"published"`
	LastPublishAt int64  `json:"lastPublishAt,omitempty"`
	LastError     string `json:"lastError,omitempty"`
}
type Publisher struct {
	mu sync.Mutex
	// model 是当前生效的北向配置与点表，整体替换（C5），读取无需加锁。
	model     atomic.Pointer[model]
	reconfMu  sync.Mutex
	stateFile string
	// state 非空时离线队列逐条写 SQLite、序号写 kv 表（G4）；原实现每条消息、每次 seq++ 都重写整个文件
	state     *db.Batch
	nextID    int64
	client    mqtt.Client
	status    Status
	queue     []queuedMessage
	OnCommand func(string, any) error
}

type model struct {
	cfg      Config
	channels []acquisition.Channel
	tags     []acquisition.Tag
}

func (p *Publisher) current() *model { return p.model.Load() }

// ConfigFromRaw 从 config.json 的 northbound 节解析配置，缺省值与旧版一致。
func ConfigFromRaw(root any) Config {
	values, _ := root.(map[string]any)
	str := func(key, fallback string) string {
		if value, ok := values[key].(string); ok && value != "" {
			return value
		}
		return fallback
	}
	enabled, _ := values["enabled"].(bool)
	flush := 1000
	if value, ok := values["dataFlushMs"].(float64); ok && value > 0 {
		flush = int(value)
	}
	return Config{Enabled: enabled, URL: str("url", "mqtt://127.0.0.1:1883"), Username: str("username", ""), Password: str("password", ""),
		GroupID: str("groupId", "Factory"), EdgeNodeID: str("edgeNodeId", "FB_Edge_GW01"), DataFlushMs: flush}
}

// TagByName 按名称查找当前点表中的位号，供 MQTT 下发命令使用。
func (p *Publisher) TagByName(name string) (acquisition.Tag, bool) {
	for _, tag := range p.current().tags {
		if tag.Name == name {
			return tag, true
		}
	}
	return acquisition.Tag{}, false
}

// SetModel 替换通道与位号（配置变更后调用），连接不中断；点表有变化时重发 BIRTH。
func (p *Publisher) SetModel(channels []acquisition.Channel, tags []acquisition.Tag) {
	p.reconfMu.Lock()
	defer p.reconfMu.Unlock()
	old := p.current()
	if reflect.DeepEqual(old.channels, channels) && reflect.DeepEqual(old.tags, tags) {
		return
	}
	p.model.Store(&model{cfg: old.cfg, channels: channels, tags: tags})
	if p.Status().Connected {
		p.publishBirths()
	}
}

// Reconfigure 应用新的北向配置（C5），不需要重启网关。
// 连接相关字段（地址、账号、组/节点 ID、启用）变化时断开并按新配置重连；否则只替换配置。
// 返回是否重连。
func (p *Publisher) Reconfigure(cfg Config) bool {
	p.reconfMu.Lock()
	defer p.reconfMu.Unlock()
	old := p.current()
	if old.cfg == cfg {
		return false
	}
	reconnect := connectionKey(old.cfg) != connectionKey(cfg)
	if reconnect {
		p.Stop()
	}
	p.model.Store(&model{cfg: cfg, channels: old.channels, tags: old.tags})
	if reconnect {
		p.Start()
	}
	return reconnect
}

func connectionKey(c Config) Config {
	c.DataFlushMs = 0
	if !c.Enabled {
		return Config{}
	}
	return c
}

type queuedMessage struct {
	id      int64
	Topic   string `json:"topic"`
	Payload []byte `json:"payload"`
	Retain  bool   `json:"retain,omitempty"`
}

func New(cfg Config, stateFile string, channels []acquisition.Channel, tags []acquisition.Tag) *Publisher {
	p := &Publisher{stateFile: stateFile}
	p.model.Store(&model{cfg: cfg, channels: channels, tags: tags})
	p.load()
	return p
}

// NewDB 使用 SQLite 持久化队列与序号；库中无状态且存在旧 northbound.json 时导入一次并改名为 .migrated。
func NewDB(cfg Config, database *db.DB, batch *db.Batch, legacyFile string, channels []acquisition.Channel, tags []acquisition.Tag) *Publisher {
	p := &Publisher{state: batch}
	p.model.Store(&model{cfg: cfg, channels: channels, tags: tags})
	var raw string
	if database.QueryRow(`SELECT value FROM kv WHERE key = 'northbound.state'`).Scan(&raw) == nil {
		var counters struct {
			BDSeq, Seq uint64
			Dropped    int
		}
		if json.Unmarshal([]byte(raw), &counters) == nil {
			p.status.BDSeq, p.status.Seq, p.status.Dropped = counters.BDSeq, counters.Seq, counters.Dropped
		}
		rows, err := database.Query(`SELECT id, topic, payload, retain FROM northbound_queue ORDER BY id`)
		if err == nil {
			for rows.Next() {
				var item queuedMessage
				var retain int
				if rows.Scan(&item.id, &item.Topic, &item.Payload, &retain) == nil {
					item.Retain = retain == 1
					p.queue = append(p.queue, item)
				}
			}
			rows.Close()
		}
		p.nextID, _ = database.NextID(context.Background(), "northbound_queue")
		return p
	}
	if legacyFile != "" {
		p.stateFile = legacyFile
		p.load()
		p.stateFile = ""
		// 旧队列里存在 payload 为 null 的条目（实测 622 条中 614 条），发出去是空帧，导入时丢弃
		kept := p.queue[:0]
		for _, item := range p.queue {
			if len(item.Payload) == 0 {
				p.status.Dropped++
				continue
			}
			p.nextID++
			item.id = p.nextID
			p.insertLocked(item)
			kept = append(kept, item)
		}
		p.queue = kept
	}
	p.saveCountersLocked()
	if batch.Flush(context.Background()) == nil && legacyFile != "" {
		if _, err := os.Stat(legacyFile); err == nil {
			_ = os.Rename(legacyFile, legacyFile+".migrated")
		}
	}
	return p
}

func (p *Publisher) insertLocked(item queuedMessage) {
	p.state.Exec(`INSERT INTO northbound_queue(id, topic, payload, retain) VALUES (?, ?, ?, ?)`, item.id, item.Topic, item.Payload, boolInt(item.Retain))
}

func (p *Publisher) saveCountersLocked() {
	b, _ := json.Marshal(struct {
		BDSeq, Seq uint64
		Dropped    int
	}{p.status.BDSeq, p.status.Seq, p.status.Dropped})
	p.state.Exec(`INSERT INTO kv(key, value) VALUES ('northbound.state', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, string(b))
}

func boolInt(v bool) int {
	if v {
		return 1
	}
	return 0
}
func (p *Publisher) Status() Status {
	p.mu.Lock()
	defer p.mu.Unlock()
	s := p.status
	s.Queued = len(p.queue)
	return s
}
func (p *Publisher) Start() {
	if cfg := p.current().cfg; !cfg.Enabled || cfg.URL == "" {
		return
	}
	p.connect()
}
func (p *Publisher) Stop() {
	p.mu.Lock()
	client := p.client
	p.client = nil
	p.status.Connected = false
	p.mu.Unlock()
	if client != nil {
		// 未连上时也要 Disconnect，否则自动重连协程会继续用旧地址重试。
		client.Disconnect(100)
	}
}
func (p *Publisher) Rebirth() { p.publishBirths() }

func (p *Publisher) connect() {
	cfg := p.current().cfg
	p.mu.Lock()
	p.status.BDSeq++
	bd := p.status.BDSeq
	p.persistLocked()
	p.mu.Unlock()
	will := encodePayload(uint64(time.Now().UnixMilli()), []metric{{Name: "bdSeq", Timestamp: time.Now().UnixMilli(), DataType: 9, Value: float64(bd)}}, 0)
	brokerURL := normalizeBrokerURL(cfg.URL)
	opts := mqtt.NewClientOptions().AddBroker(brokerURL).SetClientID(fmt.Sprintf("%s_%d", cfg.EdgeNodeID, os.Getpid())).SetCleanSession(true).SetAutoReconnect(true).SetConnectRetry(true).SetConnectRetryInterval(5 * time.Second)
	if cfg.Username != "" {
		opts.SetUsername(cfg.Username)
		opts.SetPassword(cfg.Password)
	}
	opts.SetWill(topic(cfg, "NDEATH", ""), string(will), 1, false)
	opts.OnConnect = func(client mqtt.Client) {
		p.mu.Lock()
		if p.client != client { // 已被 Reconfigure/Stop 替换的旧连接
			p.mu.Unlock()
			client.Disconnect(0)
			return
		}
		p.status.Connected = true
		p.status.LastError = ""
		p.mu.Unlock()
		client.Subscribe(fmt.Sprintf("spBv1.0/%s/STATE/+", cfg.GroupID), 1, p.handleMessage)
		client.Subscribe(fmt.Sprintf("spBv1.0/%s/CMD/%s/#", cfg.GroupID, cfg.EdgeNodeID), 1, p.handleMessage)
		p.publishBirths()
		p.flush()
	}
	opts.OnConnectionLost = func(lost mqtt.Client, err error) {
		p.mu.Lock()
		if p.client != lost {
			p.mu.Unlock()
			return
		}
		p.status.Connected = false
		if err != nil {
			p.status.LastError = err.Error()
		}
		p.mu.Unlock()
	}
	opts.SetConnectTimeout(5 * time.Second)
	client := mqtt.NewClient(opts)
	p.mu.Lock()
	p.client = client
	p.mu.Unlock()
	go func() {
		token := client.Connect()
		if token.Wait() && token.Error() != nil {
			p.mu.Lock()
			if p.client != client {
				p.mu.Unlock()
				return
			}
			p.status.LastError = token.Error().Error()
			p.status.Connected = false
			p.mu.Unlock()
		}
	}()
}

func normalizeBrokerURL(raw string) string {
	switch {
	case strings.HasPrefix(raw, "mqtt://"):
		return "tcp://" + strings.TrimPrefix(raw, "mqtt://")
	case strings.HasPrefix(raw, "mqtts://"):
		return "ssl://" + strings.TrimPrefix(raw, "mqtts://")
	default:
		return raw
	}
}

func (p *Publisher) handleMessage(_ mqtt.Client, message mqtt.Message) {
	var state struct {
		Cmd string `json:"cmd"`
	}
	if json.Unmarshal(message.Payload(), &state) == nil && state.Cmd == "REBIRTH" {
		p.publishBirths()
		return
	}
	var command struct {
		Name  string `json:"name"`
		Value any    `json:"value"`
	}
	if json.Unmarshal(message.Payload(), &command) == nil && command.Name != "" && p.OnCommand != nil {
		_ = p.OnCommand(command.Name, command.Value)
		return
	}
	if p.OnCommand != nil {
		for _, item := range decodeCommandMetrics(message.Payload()) {
			if item.Name != "" && item.Value != nil {
				_ = p.OnCommand(item.Name, item.Value)
			}
		}
	}
}

func (p *Publisher) PublishSample(sample acquisition.Sample) {
	m := p.current()
	if !m.cfg.Enabled {
		return
	}
	var value any
	if sample.Value.Number != nil {
		value = *sample.Value.Number
	} else if sample.Value.Bool != nil {
		value = *sample.Value.Bool
	} else if sample.Value.String != nil {
		value = *sample.Value.String
	} else {
		return
	}
	var tag acquisition.Tag
	for _, item := range m.tags {
		if item.ID == sample.TagID {
			tag = item
			break
		}
	}
	if tag.ID == "" {
		return
	}
	data := encodePayload(uint64(time.Now().UnixMilli()), []metric{{Name: tag.Name, Timestamp: sample.SampledAt, DataType: dataType(tag.DataType), Value: value}}, p.nextSeq())
	p.publishOrQueue(topic(m.cfg, "DDATA", channelName(m.channels, tag.ChannelID)), data)
}

func (p *Publisher) PublishShadow(snapshot any) {
	cfg := p.current().cfg
	if !cfg.Enabled {
		return
	}
	payload, err := json.Marshal(map[string]any{"ts": time.Now().UnixMilli(), "shadow": snapshot})
	if err != nil {
		return
	}
	p.publishOrQueueRetained(fmt.Sprintf("%s/shadow/%s", cfg.GroupID, cfg.EdgeNodeID), payload)
}

func (p *Publisher) publishBirths() {
	m := p.current()
	if !m.cfg.Enabled {
		return
	}
	nb := encodePayload(uint64(time.Now().UnixMilli()), []metric{{Name: "Node Control/Rebirth", Timestamp: time.Now().UnixMilli(), DataType: 12, Value: false}, {Name: "bdSeq", Timestamp: time.Now().UnixMilli(), DataType: 9, Value: float64(p.Status().BDSeq)}}, p.nextSeq())
	p.publishOrQueue(topic(m.cfg, "NBIRTH", ""), nb)
	for _, channel := range m.channels {
		if !channel.Enabled {
			continue
		}
		var metrics []metric
		for _, tag := range m.tags {
			if tag.ChannelID == channel.ID {
				metrics = append(metrics, metric{Name: tag.Name, Timestamp: time.Now().UnixMilli(), DataType: dataType(tag.DataType), Value: float64(0)})
			}
		}
		if len(metrics) > 0 {
			p.publishOrQueue(topic(m.cfg, "DBIRTH", channel.ID), encodePayload(uint64(time.Now().UnixMilli()), metrics, p.nextSeq()))
		}
	}
}

func (p *Publisher) nextSeq() uint64 {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.status.Seq++
	p.persistLocked()
	return p.status.Seq
}
func (p *Publisher) publishOrQueue(topicName string, payload []byte) {
	p.publishOrQueueWithRetain(topicName, payload, false)
}

func (p *Publisher) publishOrQueueRetained(topicName string, payload []byte) {
	p.publishOrQueueWithRetain(topicName, payload, true)
}

func (p *Publisher) publishOrQueueWithRetain(topicName string, payload []byte, retain bool) {
	p.mu.Lock()
	client := p.client
	connected := p.status.Connected && client != nil && client.IsConnected()
	p.mu.Unlock()
	if connected {
		token := client.Publish(topicName, 0, retain, payload)
		token.Wait()
		if token.Error() == nil {
			p.recordPublished()
			return
		}
	}
	p.mu.Lock()
	if isCoalescibleTopic(topicName) {
		for i := range p.queue {
			if p.queue[i].Topic == topicName {
				p.queue[i].Payload = payload
				p.queue[i].Retain = retain
				if p.state != nil {
					p.state.Exec(`UPDATE northbound_queue SET payload = ?, retain = ? WHERE id = ?`, payload, boolInt(retain), p.queue[i].id)
				} else {
					p.persistLocked()
				}
				p.mu.Unlock()
				return
			}
		}
	}
	if len(p.queue) >= 10000 {
		if p.state != nil {
			p.state.Exec(`DELETE FROM northbound_queue WHERE id = ?`, p.queue[0].id)
		}
		p.queue = p.queue[1:]
		p.status.Dropped++
	}
	p.nextID++
	item := queuedMessage{id: p.nextID, Topic: topicName, Payload: payload, Retain: retain}
	p.queue = append(p.queue, item)
	if p.state != nil {
		p.insertLocked(item)
		p.saveCountersLocked()
	} else {
		p.persistLocked()
	}
	p.mu.Unlock()
}

// DDATA and BIRTH messages describe the latest state for a topic. Keeping only
// the newest pending payload prevents a broker outage or repeated REBIRTH from
// turning the durable queue into an unbounded history of stale snapshots.
func isCoalescibleTopic(topicName string) bool {
	return strings.Contains(topicName, "/DDATA/") ||
		strings.Contains(topicName, "/NBIRTH/") ||
		strings.Contains(topicName, "/DBIRTH/") ||
		strings.Contains(topicName, "/shadow/")
}
func (p *Publisher) flush() {
	p.mu.Lock()
	client := p.client
	queue := append([]queuedMessage(nil), p.queue...)
	p.mu.Unlock()
	if client == nil || !p.Status().Connected {
		return
	}
	for _, item := range queue {
		token := client.Publish(item.Topic, 0, item.Retain, item.Payload)
		token.Wait()
		if token.Error() != nil {
			return
		}
		p.mu.Lock()
		// 按 id 出队：发送期间队首可能已因溢出被丢弃，或被合并更新
		for len(p.queue) > 0 && p.queue[0].id <= item.id {
			p.queue = p.queue[1:]
		}
		if p.state != nil {
			p.state.Exec(`DELETE FROM northbound_queue WHERE id <= ?`, item.id)
		} else {
			p.persistLocked()
		}
		p.mu.Unlock()
		p.recordPublished()
	}
}
func (p *Publisher) recordPublished() {
	p.mu.Lock()
	p.status.Published++
	p.status.LastPublishAt = time.Now().UnixMilli()
	p.mu.Unlock()
}
func (p *Publisher) load() {
	b, err := os.ReadFile(p.stateFile)
	if err != nil {
		return
	}
	var state struct {
		BDSeq, Seq uint64
		Queue      []queuedMessage
		Dropped    int
	}
	if json.Unmarshal(b, &state) == nil {
		p.status.BDSeq, p.status.Seq, p.status.Dropped, p.queue = state.BDSeq, state.Seq, state.Dropped, state.Queue
		for i := range p.queue {
			p.nextID++
			p.queue[i].id = p.nextID
		}
	}
}
func (p *Publisher) persistLocked() {
	if p.state != nil {
		p.saveCountersLocked()
		return
	}
	if p.stateFile == "" {
		return
	}
	_ = os.MkdirAll(filepath.Dir(p.stateFile), 0o750)
	b, _ := json.Marshal(struct {
		BDSeq, Seq uint64
		Queue      []queuedMessage
		Dropped    int
	}{p.status.BDSeq, p.status.Seq, p.queue, p.status.Dropped})
	_ = os.WriteFile(p.stateFile, b, 0o640)
}

type metric struct {
	Name      string
	Timestamp int64
	DataType  int
	Value     any
}

func topic(c Config, kind, device string) string {
	base := fmt.Sprintf("spBv1.0/%s/%s/%s", c.GroupID, kind, c.EdgeNodeID)
	if device != "" {
		return base + "/" + device
	}
	return base
}
func channelName(channels []acquisition.Channel, id string) string {
	for _, c := range channels {
		if c.ID == id {
			return c.ID
		}
	}
	return id
}
func dataType(t string) int {
	switch t {
	case "Bool":
		return 12
	case "String":
		return 13
	case "Double":
		return 11
	case "Float":
		return 10
	case "Int32":
		return 4
	case "UInt16":
		return 7
	default:
		return 11
	}
}
func encodePayload(timestamp uint64, metrics []metric, seq uint64) []byte {
	out := appendVarint(nil, 8, timestamp)
	for _, m := range metrics {
		encoded := encodeMetric(m)
		out = append(out, fieldBytes(2, encoded)...)
	}
	return appendVarint(out, 24, seq)
}
func encodeMetric(m metric) []byte {
	out := fieldString(1, m.Name)
	out = appendVarint(out, 24, uint64(m.Timestamp))
	out = appendVarint(out, 32, uint64(m.DataType))
	switch v := m.Value.(type) {
	case bool:
		out = appendVarint(out, 104, boolNum(v))
	case string:
		out = append(out, fieldString(14, v)...)
	case float64:
		if m.DataType == 10 {
			b := make([]byte, 4)
			binary.LittleEndian.PutUint32(b, math.Float32bits(float32(v)))
			out = append(out, 0x55)
			out = append(out, b...)
		} else if m.DataType == 11 {
			b := make([]byte, 8)
			binary.LittleEndian.PutUint64(b, math.Float64bits(v))
			out = append(out, 0x49)
			out = append(out, b...)
		} else {
			out = appendVarint(out, 88, uint64(v))
		}
	}
	return out
}
func boolNum(v bool) uint64 {
	if v {
		return 1
	}
	return 0
}
func fieldString(field uint64, value string) []byte {
	b := []byte(value)
	out := appendVarint(nil, field<<3|2, uint64(len(b)))
	return append(out, b...)
}
func fieldBytes(field uint64, value []byte) []byte {
	out := appendVarint(nil, field<<3|2, uint64(len(value)))
	return append(out, value...)
}
func appendVarint(out []byte, field, value uint64) []byte {
	out = appendUvarint(out, field)
	return appendUvarint(out, value)
}
func appendUvarint(out []byte, value uint64) []byte {
	for value >= 128 {
		out = append(out, byte(value)|128)
		value >>= 7
	}
	return append(out, byte(value))
}

type commandMetric struct {
	Name  string
	Value any
}

// decodeCommandMetrics decodes the Sparkplug B Payload/Metric subset used by
// CMD messages. It intentionally skips unknown protobuf fields so newer
// Sparkplug producers remain interoperable.
func decodeCommandMetrics(raw []byte) []commandMetric {
	var result []commandMetric
	for len(raw) > 0 {
		field, wire, n, ok := readProtoKey(raw)
		if !ok {
			break
		}
		raw = raw[n:]
		if wire == 2 {
			length, n, ok := readProtoVarint(raw)
			if !ok || length > uint64(len(raw)-n) {
				break
			}
			value := raw[n : n+int(length)]
			raw = raw[n+int(length):]
			if field == 2 {
				if metric, ok := decodeCommandMetric(value); ok {
					result = append(result, metric)
				}
			}
			continue
		}
		n, ok = skipProtoValue(raw, wire)
		if !ok {
			break
		}
		raw = raw[n:]
	}
	return result
}

func decodeCommandMetric(raw []byte) (commandMetric, bool) {
	var metric commandMetric
	var dataType uint64
	var intValue uint64
	var boolValue bool
	var floatValue float32
	var doubleValue float64
	var stringValue string
	var hasValue bool
	for len(raw) > 0 {
		field, wire, n, ok := readProtoKey(raw)
		if !ok {
			return commandMetric{}, false
		}
		raw = raw[n:]
		switch wire {
		case 0:
			value, consumed, ok := readProtoVarint(raw)
			if !ok {
				return commandMetric{}, false
			}
			raw = raw[consumed:]
			switch field {
			case 4:
				dataType = value
			case 11:
				intValue, hasValue = value, true
			case 13:
				boolValue, hasValue = value != 0, true
			}
		case 1:
			if len(raw) < 8 {
				return commandMetric{}, false
			}
			if field == 9 {
				doubleValue, hasValue = math.Float64frombits(binary.LittleEndian.Uint64(raw)), true
			}
			raw = raw[8:]
		case 5:
			if len(raw) < 4 {
				return commandMetric{}, false
			}
			if field == 10 {
				floatValue, hasValue = math.Float32frombits(binary.LittleEndian.Uint32(raw)), true
			}
			raw = raw[4:]
		case 2:
			length, consumed, ok := readProtoVarint(raw)
			if !ok || length > uint64(len(raw)-consumed) {
				return commandMetric{}, false
			}
			value := raw[consumed : consumed+int(length)]
			raw = raw[consumed+int(length):]
			if field == 1 {
				metric.Name = string(value)
			} else if field == 14 {
				stringValue, hasValue = string(value), true
			}
		default:
			return commandMetric{}, false
		}
	}
	if metric.Name == "" || !hasValue {
		return commandMetric{}, false
	}
	switch dataType {
	case 10:
		metric.Value = float64(floatValue)
	case 11:
		metric.Value = doubleValue
	case 12:
		metric.Value = boolValue
	case 13:
		metric.Value = stringValue
	default:
		metric.Value = float64(int32(uint32(intValue)))
	}
	return metric, true
}

func readProtoKey(raw []byte) (field uint64, wire byte, consumed int, ok bool) {
	value, consumed, ok := readProtoVarint(raw)
	if !ok || value>>3 == 0 {
		return 0, 0, 0, false
	}
	return value >> 3, byte(value & 7), consumed, true
}

func readProtoVarint(raw []byte) (uint64, int, bool) {
	var value uint64
	for i, b := range raw {
		if i == 10 {
			return 0, 0, false
		}
		value |= uint64(b&127) << (7 * i)
		if b < 128 {
			return value, i + 1, true
		}
	}
	return 0, 0, false
}

func skipProtoValue(raw []byte, wire byte) (int, bool) {
	switch wire {
	case 0:
		_, n, ok := readProtoVarint(raw)
		return n, ok
	case 1:
		return 8, len(raw) >= 8
	case 2:
		length, n, ok := readProtoVarint(raw)
		if !ok || length > uint64(len(raw)-n) {
			return 0, false
		}
		return n + int(length), true
	case 5:
		return 4, len(raw) >= 4
	default:
		return 0, false
	}
}
