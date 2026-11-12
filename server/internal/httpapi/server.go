package httpapi

import (
	"context"
	"html/template"
	"log/slog"
	"net/http"
	"os"
	"time"

	"github.com/gin-gonic/gin"

	"kuaiyaya/server/internal/config"
	"kuaiyaya/server/internal/license"
	"kuaiyaya/server/internal/store"
)

type Server struct {
	cfg        config.Config
	svc        *license.Service
	store      store.Store
	log        *slog.Logger
	adminToken string
	adminTmpl  *template.Template
	engine     *gin.Engine
}

func New(cfg config.Config, st store.Store, tmplHTML string, lg *slog.Logger) *Server {
	if lg == nil {
		lg = slog.New(slog.NewJSONHandler(os.Stdout, nil))
	}
	gin.SetMode(gin.ReleaseMode)
	r := gin.New()
	r.Use(gin.Recovery())
	r.Use(requestLogger(lg))

	svc := license.NewService(st)
	s := &Server{
		cfg:        cfg,
		svc:        svc,
		store:      st,
		log:        lg,
		adminToken: cfg.AdminAPIToken,
		adminTmpl:  mustTemplate("admin", tmplHTML),
		engine:     r,
	}

	lic := &licenseHandler{svc: svc, log: lg}
	adm := &adminHandler{svc: svc, log: lg}

	r.GET("/healthz", func(c *gin.Context) { c.String(http.StatusOK, "ok") })
	r.GET("/readyz", func(c *gin.Context) {
		if err := st.Ping(c.Request.Context()); err != nil {
			c.String(http.StatusServiceUnavailable, "not ready")
			return
		}
		c.String(http.StatusOK, "ok")
	})

	actLimit := newLimiter(10, 60*time.Second)
	valLimit := newLimiter(30, 60*time.Second)
	r.POST("/v1/license/activate", rateLimit(actLimit), lic.activate)
	r.POST("/v1/license/validate", rateLimit(valLimit), lic.validate)

	ag := r.Group("/v1/admin", adminAuth(cfg.AdminAPIToken))
	ag.POST("/keys", adm.issue)
	ag.GET("/keys", adm.list)
	ag.POST("/keys/:id/unbind", adm.unbind)
	ag.POST("/keys/:id/disable", adm.disable)
	ag.PATCH("/keys/:id", adm.patch)

	r.GET("/admin", s.adminHome)
	r.POST("/admin/login", s.adminLogin)
	r.POST("/admin/logout", s.adminLogout)
	r.POST("/admin/issue", s.adminIssue)
	r.POST("/admin/unbind/:id", s.adminUnbind)
	r.POST("/admin/disable/:id", s.adminDisable)

	return s
}

func (s *Server) Handler() http.Handler { return s.engine }

func (s *Server) Service() *license.Service { return s.svc }

func requestLogger(lg *slog.Logger) gin.HandlerFunc {
	return func(c *gin.Context) {
		c.Next()
		lg.Info("http",
			"method", c.Request.Method,
			"path", c.FullPath(),
			"status", c.Writer.Status(),
			"ip", c.ClientIP(),
		)
	}
}

func (s *Server) Shutdown(_ context.Context) error { return s.store.Close() }
