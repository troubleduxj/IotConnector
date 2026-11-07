package api

import (
	"crypto/rand"
	"encoding/base64"
	"net/http"
	"sync"
	"time"

	"github.com/factorybridge/iotconnector/gateway-go/internal/auth"
)

// WebSocket 一次性票据（B9）。
//
// 浏览器的 WebSocket API 不能设置 Authorization 头，控制台原先把会话令牌放进 ?token=。
// 查询参数会进入代理与访问日志、浏览器历史；令牌有效期 8 小时，泄露后可以长期冒用。
// 改为：已登录的页面先 POST /api/auth/ws-ticket 换取票据（30 秒有效、只能用一次），
// 再用 ?ticket= 建立连接。日志里即使留下票据，也已失效。
//
// 为兼容旧控制台和脚本，?token= 暂时仍可用（标记为弃用），下个版本移除。

const wsTicketTTL = 30 * time.Second

type wsTicket struct {
	principal auth.Principal
	expires   time.Time
}

type wsTicketStore struct {
	mu      sync.Mutex
	tickets map[string]wsTicket
}

func newWSTicketStore() *wsTicketStore { return &wsTicketStore{tickets: map[string]wsTicket{}} }

func (t *wsTicketStore) issue(p auth.Principal) string {
	buf := make([]byte, 24)
	_, _ = rand.Read(buf)
	ticket := base64.RawURLEncoding.EncodeToString(buf)
	now := time.Now()
	t.mu.Lock()
	for key, value := range t.tickets {
		if now.After(value.expires) {
			delete(t.tickets, key)
		}
	}
	t.tickets[ticket] = wsTicket{principal: p, expires: now.Add(wsTicketTTL)}
	t.mu.Unlock()
	return ticket
}

// redeem 取出并作废票据；过期或不存在返回 false。
func (t *wsTicketStore) redeem(ticket string) (auth.Principal, bool) {
	if ticket == "" {
		return auth.Principal{}, false
	}
	t.mu.Lock()
	value, ok := t.tickets[ticket]
	delete(t.tickets, ticket)
	t.mu.Unlock()
	if !ok || time.Now().After(value.expires) {
		return auth.Principal{}, false
	}
	return value.principal, true
}

// issueWSTicket 为当前已认证身份签发 WebSocket 票据。
func (s *Server) issueWSTicket(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	if p.MustChangePassword {
		writeJSON(w, http.StatusForbidden, map[string]any{"ok": false, "error": "password change required"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "ticket": s.wsTickets.issue(p), "expiresInSec": int(wsTicketTTL.Seconds())})
}
