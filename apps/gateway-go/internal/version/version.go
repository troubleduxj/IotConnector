// Package version 保存构建信息。发布构建通过 -ldflags 注入：
//
//	go build -ldflags "-X github.com/factorybridge/iotconnector/gateway-go/internal/version.Version=1.2.3 \
//	  -X github.com/factorybridge/iotconnector/gateway-go/internal/version.Commit=$(git rev-parse --short HEAD) \
//	  -X github.com/factorybridge/iotconnector/gateway-go/internal/version.BuildTime=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
package version

import (
	"runtime"
	"runtime/debug"
)

var (
	Version   = "0.2.0-dev"
	Commit    = ""
	BuildTime = ""
)

// Info 返回版本信息；未注入提交号时回退到 Go 工具链记录的 VCS 信息。
func Info() map[string]string {
	commit, buildTime := Commit, BuildTime
	if info, ok := debug.ReadBuildInfo(); ok {
		for _, setting := range info.Settings {
			switch setting.Key {
			case "vcs.revision":
				if commit == "" && len(setting.Value) >= 7 {
					commit = setting.Value[:7]
				}
			case "vcs.time":
				if buildTime == "" {
					buildTime = setting.Value
				}
			}
		}
	}
	return map[string]string{
		"version":   Version,
		"commit":    commit,
		"buildTime": buildTime,
		"go":        runtime.Version(),
		"platform":  runtime.GOOS + "/" + runtime.GOARCH,
	}
}
