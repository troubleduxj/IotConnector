package main

import (
	"errors"
	"fmt"
	"io"
	"os"
	"sort"
	"strconv"
	"strings"
	"sync"

	"gopkg.in/yaml.v3"
)

// 运行参数来源（H2）。优先级：命令行 > 环境变量 > 配置文件 > 默认值。
//
// 环境变量统一用 FB_ 前缀；旧名（GATEWAY_GO_*、TDENGINE_*）保留一个版本的兼容期，
// 仍然生效，但每个旧名在首次使用时打印一次弃用提示。新旧名同时设置时以新名为准。
//
// 配置文件用 --config 或 FB_CONFIG 指定，YAML 格式，键名见 settingSpecs 的 file 字段。
// 它只放运行参数；通道、位号等采集配置仍在数据目录的 config.json，经 API 修改。

type settingSpec struct {
	env    string // FB_ 新名
	legacy string // 兼容的旧名，空表示没有
	file   string // 配置文件中的键（点分路径）
}

// settingSpecs 按设置名索引。新增设置在这里登记即可同时支持三种来源。
var settingSpecs = map[string]settingSpec{
	"dataDir":       {"FB_DATA_DIR", "GATEWAY_GO_DATA_DIR", "dataDir"},
	"host":          {"FB_HOST", "GATEWAY_GO_HOST", "host"},
	"port":          {"FB_PORT", "GATEWAY_GO_PORT", "port"},
	"logLevel":      {"FB_LOG_LEVEL", "GATEWAY_GO_LOG_LEVEL", "logLevel"},
	"webDir":        {"FB_WEB_DIR", "GATEWAY_GO_WEB_DIR", "webDir"},
	"tlsCert":       {"FB_TLS_CERT", "GATEWAY_GO_TLS_CERT", "tls.cert"},
	"tlsKey":        {"FB_TLS_KEY", "GATEWAY_GO_TLS_KEY", "tls.key"},
	"allowCIDRs":    {"FB_ALLOW_CIDRS", "GATEWAY_GO_ALLOW_CIDRS", "allowCIDRs"},
	"corsOrigins":   {"FB_CORS_ORIGINS", "GATEWAY_GO_CORS_ORIGINS", "corsOrigins"},
	"dev":           {"FB_DEV", "GATEWAY_GO_DEV", ""}, // 开发模式不允许写进配置文件
	"sessionTTL":    {"FB_SESSION_TTL", "GATEWAY_GO_SESSION_TTL", "sessionTTL"},
	"outboxMax":     {"FB_OUTBOX_MAX", "GATEWAY_GO_OUTBOX_MAX", "outboxMax"},
	"driverMode":    {"FB_DRIVER_MODE", "GATEWAY_GO_DRIVER_MODE", "driverMode"},
	"apiToken":      {"FB_API_TOKEN", "GATEWAY_GO_API_TOKEN", ""}, // 令牌只走环境变量，不落文件
	"viewerToken":   {"FB_VIEWER_TOKEN", "GATEWAY_GO_VIEWER_TOKEN", ""},
	"operatorToken": {"FB_OPERATOR_TOKEN", "GATEWAY_GO_OPERATOR_TOKEN", ""},
	"adminToken":    {"FB_ADMIN_TOKEN", "GATEWAY_GO_ADMIN_TOKEN", ""},
	"tdengineURL":   {"FB_TDENGINE_URL", "TDENGINE_URL", "tdengine.url"},
	"tdengineUser":  {"FB_TDENGINE_USER", "TDENGINE_USER", "tdengine.user"},
	// 口令只走环境变量：配置文件常被拷贝、备份，不应含口令。
	"tdenginePassword": {"FB_TDENGINE_PASSWORD", "TDENGINE_PASSWORD", ""},
	"tdengineDB":       {"FB_TDENGINE_DB", "TDENGINE_DB", "tdengine.database"},
	"tdengineStable":   {"FB_TDENGINE_STABLE", "TDENGINE_STABLE", "tdengine.superTable"},
}

// fileKeys 是配置文件允许出现的键，未知键报错，避免拼错后静默不生效。
func fileKeys() map[string]string {
	keys := map[string]string{}
	for name, spec := range settingSpecs {
		if spec.file != "" {
			keys[spec.file] = name
		}
	}
	return keys
}

type settingsSource struct {
	mu       sync.Mutex
	file     map[string]string // 配置文件中的值，按设置名
	filePath string
	warned   map[string]bool
	warn     io.Writer
}

// settings 是进程内唯一的参数来源；loadConfigFile 之前只有环境变量和默认值。
var settings = &settingsSource{file: map[string]string{}, warned: map[string]bool{}, warn: os.Stderr}

// lookup 返回设置值与来源（"env"、"legacy-env"、"file"），未设置时 ok=false。
func (s *settingsSource) lookup(name string) (string, string, bool) {
	spec, known := settingSpecs[name]
	if !known {
		panic("unknown setting " + name)
	}
	if value := os.Getenv(spec.env); value != "" {
		return value, "env", true
	}
	if spec.legacy != "" {
		if value := os.Getenv(spec.legacy); value != "" {
			s.mu.Lock()
			if !s.warned[spec.legacy] {
				s.warned[spec.legacy] = true
				fmt.Fprintf(s.warn, "环境变量 %s 已弃用，请改用 %s（下个版本移除旧名）\n", spec.legacy, spec.env)
			}
			s.mu.Unlock()
			return value, "legacy-env", true
		}
	}
	s.mu.Lock()
	value, ok := s.file[name]
	s.mu.Unlock()
	if ok {
		return value, "file", true
	}
	return "", "", false
}

func setting(name, fallback string) string {
	if value, _, ok := settings.lookup(name); ok {
		return value
	}
	return fallback
}

// settingSet 报告该设置是否由环境变量或配置文件显式给出（用于判断数据目录是否显式指定）。
func settingSet(name string) bool {
	_, _, ok := settings.lookup(name)
	return ok
}

// loadConfigFile 读取 YAML 配置文件。path 为空时什么也不做。
func (s *settingsSource) loadConfigFile(path string) error {
	if path == "" {
		return nil
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return fmt.Errorf("读取配置文件 %s：%w", path, err)
	}
	var root map[string]any
	if err := yaml.Unmarshal(data, &root); err != nil {
		return fmt.Errorf("解析配置文件 %s：%w", path, err)
	}
	flat := map[string]string{}
	if err := flatten("", root, flat); err != nil {
		return fmt.Errorf("配置文件 %s：%w", path, err)
	}
	keys := fileKeys()
	values := map[string]string{}
	var unknown []string
	for key, value := range flat {
		name, ok := keys[key]
		if !ok {
			unknown = append(unknown, key)
			continue
		}
		values[name] = value
	}
	if len(unknown) > 0 {
		sort.Strings(unknown)
		return fmt.Errorf("配置文件 %s 含未知键：%s（口令与令牌只能用环境变量设置）", path, strings.Join(unknown, ", "))
	}
	s.mu.Lock()
	s.file, s.filePath = values, path
	s.mu.Unlock()
	return nil
}

// flatten 把嵌套映射展开为点分键；列表按逗号连接（allowCIDRs、corsOrigins）。
func flatten(prefix string, value any, out map[string]string) error {
	switch typed := value.(type) {
	case map[string]any:
		for key, item := range typed {
			child := key
			if prefix != "" {
				child = prefix + "." + key
			}
			if err := flatten(child, item, out); err != nil {
				return err
			}
		}
	case []any:
		parts := make([]string, 0, len(typed))
		for _, item := range typed {
			switch item.(type) {
			case map[string]any, []any:
				return fmt.Errorf("%s：列表元素只能是标量", prefix)
			}
			parts = append(parts, fmt.Sprint(item))
		}
		out[prefix] = strings.Join(parts, ",")
	case nil:
		// 空值视为未设置
	default:
		if prefix == "" {
			return errors.New("顶层必须是映射")
		}
		out[prefix] = fmt.Sprint(typed)
	}
	return nil
}

// configFilePath 从参数中预先取出 --config（在定义其余 flag 之前需要它来确定默认值）。
func configFilePath(args []string) string {
	for i, arg := range args {
		if arg == "--" {
			break
		}
		for _, prefix := range []string{"--config=", "-config="} {
			if strings.HasPrefix(arg, prefix) {
				return strings.TrimPrefix(arg, prefix)
			}
		}
		if (arg == "--config" || arg == "-config") && i+1 < len(args) {
			return args[i+1]
		}
	}
	if value := os.Getenv("FB_CONFIG"); value != "" {
		return value
	}
	return ""
}

func settingInt(name string, fallback int) int {
	value := setting(name, "")
	if value == "" {
		return fallback
	}
	n, err := strconv.Atoi(value)
	if err != nil || n < 1 {
		fmt.Fprintf(settings.warn, "%s 的值 %q 无效，使用默认值 %d\n", settingSpecs[name].env, value, fallback)
		return fallback
	}
	return n
}
