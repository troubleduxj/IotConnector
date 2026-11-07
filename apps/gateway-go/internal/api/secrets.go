package api

import (
	"net/url"
	"strings"
)

// 敏感字段只写不读（B4）：GET 接口把这些键清空，并附带 <key>Set 布尔值告诉界面是否已配置；
// PUT 时若这些键为空字符串或缺省，保留已存的值。
// 控制台原样回传它读到的配置，所以空值回传不会抹掉密钥。
//
// 键名不区分大小写，按路径末段匹配，覆盖 notifications.email.password、
// notifications.dingtalk.secret、northbound.password 等。
var secretKeys = map[string]bool{
	"password":     true,
	"secret":       true,
	"token":        true,
	"apikey":       true,
	"passwordhash": true,
}

// webhook 地址本身就是凭据（钉钉、企微的 access_token 在 URL 里），同样只写不读。
var secretURLKeys = map[string]bool{
	"webhookurl": true,
}

func isSecretKey(key string) bool {
	lower := strings.ToLower(key)
	return secretKeys[lower] || secretURLKeys[lower]
}

// redactSecrets 返回深拷贝，敏感字段置空并加 <key>Set 标记。不修改输入。
func redactSecrets(value any) any {
	switch typed := value.(type) {
	case map[string]any:
		out := make(map[string]any, len(typed))
		for key, item := range typed {
			if isSecretKey(key) {
				text, _ := item.(string)
				out[key] = ""
				out[key+"Set"] = text != ""
				continue
			}
			out[key] = redactSecrets(item)
		}
		return out
	case []any:
		out := make([]any, len(typed))
		for i, item := range typed {
			out[i] = redactSecrets(item)
		}
		return out
	default:
		return value
	}
}

// preserveSecrets 处理 PUT 补丁：补丁里为空的敏感字段删掉（保留原值），
// 并丢弃界面回传的 <key>Set 标记，避免它被写进配置。原地修改 patch。
func preserveSecrets(patch map[string]any) {
	for key, item := range patch {
		if strings.HasSuffix(key, "Set") && isSecretKey(strings.TrimSuffix(key, "Set")) {
			delete(patch, key)
			continue
		}
		if isSecretKey(key) {
			if text, ok := item.(string); ok && text == "" {
				delete(patch, key)
			} else if item == nil {
				delete(patch, key)
			}
			continue
		}
		if nested, ok := item.(map[string]any); ok {
			preserveSecrets(nested)
		}
	}
}

// redactURLCredentials 去掉 URL 中的用户名口令（如 http://root:taosdata@host:6041）。
func redactURLCredentials(raw string) string {
	u, err := url.Parse(raw)
	if err != nil || u.User == nil {
		return raw
	}
	u.User = nil
	return u.String()
}
