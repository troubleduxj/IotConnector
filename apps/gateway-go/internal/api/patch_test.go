package api

import (
	"net/http"
	"testing"

	"github.com/factorybridge/iotconnector/gateway-go/internal/acquisition"
	"github.com/factorybridge/iotconnector/gateway-go/internal/config"
	"github.com/factorybridge/iotconnector/gateway-go/internal/domain"
)

func newPatchTestServer() *Server {
	return NewServerWithOptions(config.Config{
		Channels: []domain.Channel{{ID: "c1", Name: "A", Protocol: "Modbus TCP", Host: "h", Port: 502, Params: map[string]any{}}},
		Tags:     []domain.Tag{{ID: "t1", ChannelID: "c1", Name: "T", Address: "40001"}},
	}, acquisition.NewEngine(nil, nil, nil), SecurityOptions{AdminToken: "t"})
}

func TestUpdateChannelIgnoresIDChange(t *testing.T) {
	s := newPatchTestServer()
	h := s.Handler()
	resp := call(h, http.MethodPut, "/api/channels/c1", "t", `{"id":"hijack","name":"B"}`)
	if resp.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", resp.Code, resp.Body.String())
	}
	ch := s.cfg().Channels[0]
	if ch.ID != "c1" {
		t.Errorf("channel ID = %q, want c1", ch.ID)
	}
	if ch.Name != "B" {
		t.Errorf("channel name = %q, want B", ch.Name)
	}
}

func TestUpdateChannelRejectsInvalidPort(t *testing.T) {
	s := newPatchTestServer()
	h := s.Handler()
	resp := call(h, http.MethodPut, "/api/channels/c1", "t", `{"port":70000}`)
	if resp.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400, body = %s", resp.Code, resp.Body.String())
	}
	if port := s.cfg().Channels[0].Port; port != 502 {
		t.Errorf("port = %d, want 502", port)
	}
}

func TestUpdateChannelRejectsEmptyName(t *testing.T) {
	s := newPatchTestServer()
	h := s.Handler()
	resp := call(h, http.MethodPut, "/api/channels/c1", "t", `{"name":""}`)
	if resp.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400, body = %s", resp.Code, resp.Body.String())
	}
	if name := s.cfg().Channels[0].Name; name != "A" {
		t.Errorf("name = %q, want A", name)
	}
}

func TestUpdateTagIgnoresIDAndChannelIDChange(t *testing.T) {
	s := newPatchTestServer()
	h := s.Handler()
	resp := call(h, http.MethodPut, "/api/tags/t1", "t", `{"id":"x","channelId":"nope","name":"T2"}`)
	if resp.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", resp.Code, resp.Body.String())
	}
	tag := s.cfg().Tags[0]
	if tag.ID != "t1" {
		t.Errorf("tag ID = %q, want t1", tag.ID)
	}
	if tag.ChannelID != "c1" {
		t.Errorf("tag channelId = %q, want c1", tag.ChannelID)
	}
	if tag.Name != "T2" {
		t.Errorf("tag name = %q, want T2", tag.Name)
	}
}

func TestUpdateTagRejectsEmptyAddress(t *testing.T) {
	s := newPatchTestServer()
	h := s.Handler()
	resp := call(h, http.MethodPut, "/api/tags/t1", "t", `{"address":""}`)
	if resp.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400, body = %s", resp.Code, resp.Body.String())
	}
	if addr := s.cfg().Tags[0].Address; addr != "40001" {
		t.Errorf("address = %q, want 40001", addr)
	}
}
