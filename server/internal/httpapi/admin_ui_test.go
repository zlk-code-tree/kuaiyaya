package httpapi

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"kuaiyaya/server/internal/config"
	"kuaiyaya/server/internal/license"
	"kuaiyaya/server/internal/store"
	"kuaiyaya/server/web"
)

const adminDevice = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

func TestAdminPublicBasePath(t *testing.T) {
	cases := []struct {
		name     string
		base     string
		login    string
		location string
		cookie   string
	}{
		{
			name:     "prefixed",
			base:     "/kuaiyaya",
			login:    `action="/kuaiyaya/admin/login"`,
			location: "/kuaiyaya/admin",
			cookie:   "/kuaiyaya/admin",
		},
		{
			name:     "empty",
			base:     "",
			login:    `action="/admin/login"`,
			location: "/admin",
			cookie:   "/admin",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			mem := store.NewMemory()
			cfg := config.Config{
				AdminAPIToken:  "test-admin-token-32bytes-minimum",
				PublicBasePath: tc.base,
			}
			s := New(cfg, mem, web.AdminHTML, nil)
			prefix := tc.base

			body := serve(t, s, http.MethodGet, "/admin", nil, "")
			if body.code != http.StatusOK || !strings.Contains(body.text, tc.login) {
				t.Fatalf("login form: status %d body %s", body.code, body.text)
			}
			if tc.base != "" && strings.Contains(body.text, `action="/admin/login"`) {
				t.Fatalf("login form dropped the prefix: %s", body.text)
			}
			if strings.Contains(body.text, `action="`+prefix+`//admin`) {
				t.Fatalf("doubled slash in form action: %s", body.text)
			}

			miss := serve(t, s, http.MethodPost, prefix+"/admin/login", strings.NewReader(url.Values{"token": {cfg.AdminAPIToken}}.Encode()), "")
			if prefix != "" && miss.code != http.StatusNotFound {
				t.Fatalf("prefixed route should stay unregistered, got %d", miss.code)
			}

			login := serve(t, s, http.MethodPost, "/admin/login", strings.NewReader(url.Values{"token": {cfg.AdminAPIToken}}.Encode()), "application/x-www-form-urlencoded")
			if login.code != http.StatusFound {
				t.Fatalf("login status %d body %s", login.code, login.text)
			}
			if got := login.header.Get("Location"); got != tc.location {
				t.Fatalf("login location %q", got)
			}
			cookie := sessionCookie(t, login.header)
			if cookie.Path != tc.cookie || !cookie.HttpOnly || cookie.Value != cfg.AdminAPIToken {
				t.Fatalf("login cookie path=%q httpOnly=%v value=%q", cookie.Path, cookie.HttpOnly, cookie.Value)
			}
			auth := cookie.Name + "=" + cookie.Value

			home := serve(t, s, http.MethodGet, "/admin", nil, "", auth)
			for _, action := range []string{
				`action="` + prefix + `/admin/logout"`,
				`action="` + prefix + `/admin/issue"`,
				`method="get" action="` + prefix + `/admin"`,
			} {
				if !strings.Contains(home.text, action) {
					t.Fatalf("missing %s in %s", action, home.text)
				}
			}

			issued, err := s.Service().IssueKeys(context.Background(), license.IssueInput{Count: 1})
			if err != nil {
				t.Fatal(err)
			}
			activated := serve(t, s, http.MethodPost, "/v1/license/activate", strings.NewReader(`{"key":"`+issued[0].Key+`","deviceId":"`+adminDevice+`"}`), "application/json")
			if activated.code != http.StatusOK {
				t.Fatalf("activate %d %s", activated.code, activated.text)
			}
			bound := serve(t, s, http.MethodGet, "/admin", nil, "", auth)
			id := itoa(int(issued[0].ID))
			for _, action := range []string{
				`action="` + prefix + `/admin/unbind/` + id + `"`,
				`action="` + prefix + `/admin/disable/` + id + `"`,
			} {
				if !strings.Contains(bound.text, action) {
					t.Fatalf("missing %s in %s", action, bound.text)
				}
			}

			badDate := serve(t, s, http.MethodPost, "/admin/issue", strings.NewReader(url.Values{"count": {"1"}, "expiresAt": {"not-a-date"}}.Encode()), "application/x-www-form-urlencoded", auth)
			if badDate.code != http.StatusFound || unescapeLocation(t, badDate.header) != tc.location+"?flash=到期日格式不正确" {
				t.Fatalf("issue redirect %d %q", badDate.code, badDate.header.Get("Location"))
			}

			unbind := serve(t, s, http.MethodPost, "/admin/unbind/"+id, strings.NewReader(url.Values{"reason": {"管理页解绑"}}.Encode()), "application/x-www-form-urlencoded", auth)
			if unbind.code != http.StatusFound || unescapeLocation(t, unbind.header) != tc.location+"?flash=已解绑" {
				t.Fatalf("unbind redirect %d %q", unbind.code, unbind.header.Get("Location"))
			}

			disable := serve(t, s, http.MethodPost, "/admin/disable/"+id, strings.NewReader(url.Values{"reason": {"管理页停用"}}.Encode()), "application/x-www-form-urlencoded", auth)
			if disable.code != http.StatusFound || unescapeLocation(t, disable.header) != tc.location+"?flash=已停用" {
				t.Fatalf("disable redirect %d %q", disable.code, disable.header.Get("Location"))
			}

			logout := serve(t, s, http.MethodPost, "/admin/logout", nil, "", auth)
			if logout.code != http.StatusFound || logout.header.Get("Location") != tc.location {
				t.Fatalf("logout location %d %q", logout.code, logout.header.Get("Location"))
			}
			cleared := sessionCookie(t, logout.header)
			if cleared.Path != tc.cookie {
				t.Fatalf("logout cookie path=%q", cleared.Path)
			}
		})
	}
}

type recorded struct {
	code   int
	text   string
	header http.Header
}

func serve(t *testing.T, s *Server, method, path string, body io.Reader, contentType string, cookie ...string) recorded {
	t.Helper()
	req := httptest.NewRequest(method, path, body)
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	if len(cookie) > 0 && cookie[0] != "" {
		req.Header.Set("Cookie", cookie[0])
	}
	w := httptest.NewRecorder()
	s.Handler().ServeHTTP(w, req)
	return recorded{code: w.Code, text: w.Body.String(), header: w.Header()}
}

func unescapeLocation(t *testing.T, header http.Header) string {
	t.Helper()
	decoded, err := url.PathUnescape(header.Get("Location"))
	if err != nil {
		t.Fatal(err)
	}
	return decoded
}

func sessionCookie(t *testing.T, header http.Header) *http.Cookie {
	t.Helper()
	res := &http.Response{Header: header}
	for _, cookie := range res.Cookies() {
		if cookie.Name == adminCookie {
			return cookie
		}
	}
	t.Fatalf("missing %s cookie in %v", adminCookie, header.Values("Set-Cookie"))
	return nil
}
