package config

import (
	"fmt"
	"os"
	"strings"

	"github.com/joho/godotenv"
)

type Config struct {
	HTTPAddr           string
	DatabaseURL        string
	AdminAPIToken      string
	AutoMigrate        bool
	LogLevel           string
	PublicBasePath     string
	UpdateManifestPath string
}

func Load() (Config, error) {
	// 允许从 server/.env 或当前目录加载；不存在时忽略。
	_ = godotenv.Load()
	_ = godotenv.Load(".env")

	cfg := Config{
		HTTPAddr:           env("HTTP_ADDR", "127.0.0.1:8080"),
		DatabaseURL:        os.Getenv("DATABASE_URL"),
		AdminAPIToken:      os.Getenv("ADMIN_API_TOKEN"),
		AutoMigrate:        envBool("AUTO_MIGRATE", true),
		LogLevel:           env("LOG_LEVEL", "info"),
		PublicBasePath:     strings.TrimRight(env("PUBLIC_BASE_PATH", ""), "/"),
		UpdateManifestPath: strings.TrimSpace(os.Getenv("UPDATE_MANIFEST_PATH")),
	}
	if strings.TrimSpace(cfg.DatabaseURL) == "" {
		return cfg, fmt.Errorf("DATABASE_URL 未配置")
	}
	if strings.TrimSpace(cfg.AdminAPIToken) == "" {
		return cfg, fmt.Errorf("ADMIN_API_TOKEN 未配置")
	}
	if len(cfg.AdminAPIToken) < 16 {
		return cfg, fmt.Errorf("ADMIN_API_TOKEN 过短，建议至少 32 字节随机串")
	}
	return cfg, nil
}

func env(key, fallback string) string {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		return v
	}
	return fallback
}

func envBool(key string, fallback bool) bool {
	v := strings.TrimSpace(os.Getenv(key))
	if v == "" {
		return fallback
	}
	switch strings.ToLower(v) {
	case "1", "true", "yes", "on":
		return true
	case "0", "false", "no", "off":
		return false
	default:
		return fallback
	}
}
