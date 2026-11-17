package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"kuaiyaya/server/internal/config"
	"kuaiyaya/server/internal/store"
)

func releaseServer(path string) http.Handler {
	return New(config.Config{UpdateManifestPath: path, AdminAPIToken: "test-token"}, store.NewMemory(), html, nil).Handler()
}

func TestLatestReleaseByPlatformAndReload(t *testing.T) {
	path := filepath.Join(t.TempDir(), "release.json")
	manifest := `{"releases":[{"platform":"darwin","arch":"arm64","version":"1.0.2","notes":"画质改进","downloadUrl":"https://example.com/mac.dmg"},{"platform":"win32","arch":"x64","version":"1.1.0","notes":"Windows 更新","downloadUrl":"https://example.com/windows.zip"}]}`
	if err := os.WriteFile(path, []byte(manifest), 0600); err != nil {
		t.Fatal(err)
	}
	h := releaseServer(path)
	code, body := doJSON(t, h, "GET", "/v1/app/releases/latest?platform=darwin&arch=arm64", nil, nil)
	if code != 200 || body["data"].(map[string]any)["version"] != "1.0.2" {
		t.Fatalf("mac: %d %v", code, body)
	}
	code, body = doJSON(t, h, "GET", "/v1/app/releases/latest?platform=win32&arch=x64", nil, nil)
	if code != 200 || body["data"].(map[string]any)["version"] != "1.1.0" {
		t.Fatalf("windows: %d %v", code, body)
	}
	if err := os.WriteFile(path, []byte(`{"releases":[]}`), 0600); err != nil {
		t.Fatal(err)
	}
	code, body = doJSON(t, h, "GET", "/v1/app/releases/latest?platform=darwin&arch=arm64", nil, nil)
	if code != 200 || body["data"] != nil {
		t.Fatalf("empty: %d %v", code, body)
	}
}

func TestReleaseUnavailableOrUnsafe(t *testing.T) {
	path := filepath.Join(t.TempDir(), "release.json")
	h := releaseServer(path)
	code, _ := doJSON(t, h, "GET", "/v1/app/releases/latest?platform=darwin&arch=arm64", nil, nil)
	if code != 503 {
		t.Fatalf("missing file: %d", code)
	}
	invalid := []string{
		`not-json`,
		`{"releases":[{"platform":"darwin","arch":"arm64","version":"1.0.2","downloadUrl":"http://example.com/file"}]}`,
		`{"releases":[{"platform":"darwin","arch":"arm64","version":"1.0.2","downloadUrl":"https://example.com/a"},{"platform":"darwin","arch":"arm64","version":"1.0.3","downloadUrl":"https://example.com/b"}]}`,
		`{"releases":[{"platform":"darwin","arch":"arm64","version":"1.0.2-beta","downloadUrl":"https://example.com/a"}]}`,
	}
	for _, input := range invalid {
		if err := os.WriteFile(path, []byte(input), 0600); err != nil {
			t.Fatal(err)
		}
		code, _ = doJSON(t, h, "GET", "/v1/app/releases/latest?platform=darwin&arch=arm64", nil, nil)
		if code != 503 {
			t.Fatalf("unsafe manifest %s: %d", input, code)
		}
	}
	code, _ = doJSON(t, h, "GET", "/v1/app/releases/latest?platform=linux&arch=x64", nil, nil)
	if code != 400 {
		t.Fatalf("unsupported platform: %d", code)
	}
}

func TestReleaseDisabled(t *testing.T) {
	w := httptest.NewRecorder()
	releaseServer("").ServeHTTP(w, httptest.NewRequest("GET", "/v1/app/releases/latest?platform=darwin&arch=arm64", nil))
	var body map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if w.Code != 200 || body["ok"] != true || body["data"] != nil || w.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("disabled: %v %v", w.Code, body)
	}
}
