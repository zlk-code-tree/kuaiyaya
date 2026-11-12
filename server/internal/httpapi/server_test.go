package httpapi

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"kuaiyaya/server/internal/config"
	"kuaiyaya/server/internal/license"
	"kuaiyaya/server/internal/store"
)

const (
	devA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	devB = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
	html = `<html><body>{{if .Authed}}ok{{else}}login{{end}}</body></html>`
)

func testServer(t *testing.T) (*Server, *store.Memory) {
	t.Helper()
	mem := store.NewMemory()
	cfg := config.Config{
		HTTPAddr:      "127.0.0.1:0",
		AdminAPIToken: "test-admin-token-32bytes-minimum",
		LogLevel:      "error",
	}
	s := New(cfg, mem, html, nil)
	s.svc.Now = func() time.Time { return time.Date(2026, 11, 12, 4, 0, 0, 0, time.UTC) }
	return s, mem
}

func doJSON(t *testing.T, h http.Handler, method, path string, body any, headers map[string]string) (int, map[string]any) {
	t.Helper()
	var rdr io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
		rdr = bytes.NewReader(b)
	}
	req := httptest.NewRequest(method, path, rdr)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	var out map[string]any
	if w.Body.Len() > 0 && w.Header().Get("Content-Type") != "text/html; charset=utf-8" {
		_ = json.Unmarshal(w.Body.Bytes(), &out)
	}
	return w.Code, out
}

func TestHealthz(t *testing.T) {
	s, _ := testServer(t)
	code, _ := doJSON(t, s.Handler(), "GET", "/healthz", nil, nil)
	if code != 200 {
		t.Fatalf("healthz %d", code)
	}
	code, _ = doJSON(t, s.Handler(), "GET", "/readyz", nil, nil)
	if code != 200 {
		t.Fatalf("readyz %d", code)
	}
}

func TestActivateValidateRoundtrip(t *testing.T) {
	s, _ := testServer(t)
	issued, err := s.svc.IssueKeys(nil, license.IssueInput{Count: 1})
	if err != nil {
		t.Fatal(err)
	}
	key := issued[0].Key
	code, body := doJSON(t, s.Handler(), "POST", "/v1/license/activate", map[string]any{
		"key": key, "deviceId": devA, "appVersion": "1.0.0", "platform": "darwin", "arch": "arm64",
	}, nil)
	if code != 200 || body["ok"] != true {
		t.Fatalf("activate %d %v", code, body)
	}
	data := body["data"].(map[string]any)
	if _, ok := data["expiresAt"]; !ok {
		t.Fatal("missing expiresAt")
	}
	if _, ok := data["serverTime"]; !ok {
		t.Fatal("missing serverTime")
	}
	if _, has := data["bind_token"]; has {
		t.Fatal("must not return bind_token")
	}

	code, body = doJSON(t, s.Handler(), "POST", "/v1/license/validate", map[string]any{
		"key": key, "deviceId": devA, "appVersion": "1.0.0",
	}, nil)
	if code != 200 || body["ok"] != true {
		t.Fatalf("validate %d %v", code, body)
	}
}

func TestValidateDoesNotBind(t *testing.T) {
	s, _ := testServer(t)
	issued, _ := s.svc.IssueKeys(nil, license.IssueInput{Count: 1})
	code, body := doJSON(t, s.Handler(), "POST", "/v1/license/validate", map[string]any{
		"key": issued[0].Key, "deviceId": devA,
	}, nil)
	if code != 409 {
		t.Fatalf("want 409, got %d %v", code, body)
	}
	err := body["error"].(map[string]any)
	if err["code"] != license.CodeNotBound {
		t.Fatalf("want not_bound, got %v", err)
	}
}

func TestInvalidRequestAndInvalidKey(t *testing.T) {
	s, _ := testServer(t)
	code, body := doJSON(t, s.Handler(), "POST", "/v1/license/activate", map[string]any{
		"key": "KYDY-AAAA-BBBB-CCCC", "deviceId": "short",
	}, nil)
	if code != 400 || body["error"].(map[string]any)["code"] != license.CodeInvalidRequest {
		t.Fatalf("bad deviceId: %d %v", code, body)
	}
	code, body = doJSON(t, s.Handler(), "POST", "/v1/license/activate", map[string]any{
		"key": "KYDY-AAAA-BBBB-CCCC", "deviceId": devA,
	}, nil)
	if code != 403 || body["error"].(map[string]any)["code"] != license.CodeInvalid {
		t.Fatalf("missing key: %d %v", code, body)
	}
}

func TestSecondDeviceConflict(t *testing.T) {
	s, _ := testServer(t)
	issued, _ := s.svc.IssueKeys(nil, license.IssueInput{Count: 1})
	key := issued[0].Key
	doJSON(t, s.Handler(), "POST", "/v1/license/activate", map[string]any{"key": key, "deviceId": devA}, nil)
	code, body := doJSON(t, s.Handler(), "POST", "/v1/license/activate", map[string]any{"key": key, "deviceId": devB}, nil)
	if code != 409 || body["error"].(map[string]any)["code"] != license.CodeKeyBoundToOtherDevice {
		t.Fatalf("got %d %v", code, body)
	}
}

func TestAdminUnauthorized(t *testing.T) {
	s, _ := testServer(t)
	code, body := doJSON(t, s.Handler(), "GET", "/v1/admin/keys", nil, nil)
	if code != 401 || body["error"].(map[string]any)["code"] != license.CodeAdminUnauthorized {
		t.Fatalf("no token: %d %v", code, body)
	}
	code, body = doJSON(t, s.Handler(), "GET", "/v1/admin/keys", nil, map[string]string{"Authorization": "Bearer wrong"})
	if code != 401 {
		t.Fatalf("bad token: %d", code)
	}
}

func TestAdminIssueListUnbindDisable(t *testing.T) {
	s, _ := testServer(t)
	auth := map[string]string{"Authorization": "Bearer test-admin-token-32bytes-minimum"}
	code, body := doJSON(t, s.Handler(), "POST", "/v1/admin/keys", map[string]any{
		"count": 1, "issuedTo": "张三", "remark": "试用", "actor": "admin",
	}, auth)
	if code != 200 {
		t.Fatalf("issue %d %v", code, body)
	}
	keys := body["data"].(map[string]any)["keys"].([]any)
	item := keys[0].(map[string]any)
	key := item["key"].(string)
	id := int(item["id"].(float64))

	// 绑定后再列出来
	doJSON(t, s.Handler(), "POST", "/v1/license/activate", map[string]any{"key": key, "deviceId": devA, "deviceLabel": "Test Mac"}, nil)
	code, body = doJSON(t, s.Handler(), "GET", "/v1/admin/keys?status=bound", nil, auth)
	if code != 200 {
		t.Fatal(body)
	}

	code, _ = doJSON(t, s.Handler(), "POST", "/v1/admin/keys/"+itoa(id)+"/unbind", map[string]any{"reason": "换机", "actor": "admin"}, auth)
	if code != 200 {
		t.Fatalf("unbind %d", code)
	}
	_, body = doJSON(t, s.Handler(), "POST", "/v1/license/validate", map[string]any{"key": key, "deviceId": devA}, nil)
	if body["error"].(map[string]any)["code"] != license.CodeNotBound {
		t.Fatalf("after unbind validate: %v", body)
	}

	code, _ = doJSON(t, s.Handler(), "POST", "/v1/admin/keys/"+itoa(id)+"/disable", map[string]any{"reason": "不用了", "actor": "admin"}, auth)
	if code != 200 {
		t.Fatalf("disable %d", code)
	}
	code, body = doJSON(t, s.Handler(), "POST", "/v1/license/activate", map[string]any{"key": key, "deviceId": devA}, nil)
	if code != 403 || body["error"].(map[string]any)["code"] != license.CodeInvalid {
		t.Fatalf("disabled activate: %d %v", code, body)
	}
}

func itoa(i int) string {
	if i == 0 {
		return "0"
	}
	var b [16]byte
	n := len(b)
	for i > 0 {
		n--
		b[n] = byte('0' + i%10)
		i /= 10
	}
	return string(b[n:])
}
