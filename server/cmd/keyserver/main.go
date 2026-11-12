package main

import (
	"context"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"kuaiyaya/server/internal/config"
	"kuaiyaya/server/internal/httpapi"
	"kuaiyaya/server/internal/store"
	"kuaiyaya/server/web"
)

func main() {
	migrateOnly := false
	if len(os.Args) > 1 && (os.Args[1] == "-migrate" || os.Args[1] == "--migrate") {
		migrateOnly = true
	}

	log := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: parseLevel(os.Getenv("LOG_LEVEL"))}))

	cfg, err := config.Load()
	if err != nil {
		log.Error("config", "err", err)
		os.Exit(1)
	}

	ms, err := store.OpenMySQL(cfg.DatabaseURL)
	if err != nil {
		log.Error("mysql", "err", err)
		os.Exit(1)
	}

	if migrateOnly || cfg.AutoMigrate {
		file, err := store.FindMigrationFile("")
		if err != nil {
			log.Error("find migration", "err", err)
			os.Exit(1)
		}
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		err = store.Migrate(ctx, ms.DB, file)
		cancel()
		if err != nil {
			log.Error("migrate", "err", err)
			os.Exit(1)
		}
		log.Info("migrate ok", "file", file)
		if migrateOnly {
			return
		}
	}

	srv := httpapi.New(cfg, ms, web.AdminHTML, log)
	httpSrv := &http.Server{Addr: cfg.HTTPAddr, Handler: srv.Handler()}

	go func() {
		log.Info("keyserver listening", "addr", cfg.HTTPAddr)
		if err := httpSrv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Error("listen", "err", err)
			os.Exit(1)
		}
	}()

	ch := make(chan os.Signal, 1)
	signal.Notify(ch, syscall.SIGINT, syscall.SIGTERM)
	<-ch
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	_ = httpSrv.Shutdown(ctx)
	_ = ms.Close()
}

func parseLevel(s string) slog.Level {
	switch strings.ToLower(s) {
	case "debug":
		return slog.LevelDebug
	case "warn", "warning":
		return slog.LevelWarn
	case "error":
		return slog.LevelError
	default:
		return slog.LevelInfo
	}
}
