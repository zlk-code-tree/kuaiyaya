package config

import "testing"

func TestLoadPublicBasePath(t *testing.T) {
	t.Setenv("DATABASE_URL", "root:password@tcp(127.0.0.1:3306)/kuaiyaya?parseTime=true")
	t.Setenv("ADMIN_API_TOKEN", "test-admin-token-32bytes-minimum")

	t.Setenv("PUBLIC_BASE_PATH", "/kuaiyaya/")
	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.PublicBasePath != "/kuaiyaya" {
		t.Fatalf("trailing slash: got %q", cfg.PublicBasePath)
	}

	t.Setenv("PUBLIC_BASE_PATH", " /kuaiyaya/// ")
	cfg, err = Load()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.PublicBasePath != "/kuaiyaya" {
		t.Fatalf("extra slashes: got %q", cfg.PublicBasePath)
	}

	t.Setenv("PUBLIC_BASE_PATH", "")
	cfg, err = Load()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.PublicBasePath != "" {
		t.Fatalf("empty: got %q", cfg.PublicBasePath)
	}
}
