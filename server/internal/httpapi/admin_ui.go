package httpapi

import (
	"html/template"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"kuaiyaya/server/internal/license"
	"kuaiyaya/server/internal/store"
)

const adminCookie = "kuaiyaya_admin"

type adminPageData struct {
	Authed   bool
	Flash    string
	FlashErr bool
	Status   string
	Keys     []store.KeyListItem
	Issued   []license.IssuedKey
	Now      time.Time
}

func (s *Server) adminAuthed(c *gin.Context) bool {
	tok, err := c.Cookie(adminCookie)
	return err == nil && tok != "" && tok == s.adminToken
}

func (s *Server) requireAdminPage(c *gin.Context) bool {
	if s.adminAuthed(c) {
		return true
	}
	s.renderAdmin(c, adminPageData{Flash: "请先登录"})
	return false
}

func (s *Server) renderAdmin(c *gin.Context, data adminPageData) {
	c.Header("Content-Type", "text/html; charset=utf-8")
	c.Status(http.StatusOK)
	if err := s.adminTmpl.Execute(c.Writer, data); err != nil {
		s.log.Error("render admin", "err", err)
	}
}

func (s *Server) adminHome(c *gin.Context) {
	if !s.adminAuthed(c) {
		s.renderAdmin(c, adminPageData{Flash: c.Query("flash")})
		return
	}
	status := c.Query("status")
	items, err := s.svc.ListKeys(c.Request.Context(), status)
	if err != nil {
		s.renderAdmin(c, adminPageData{Authed: true, Flash: "读取失败：" + err.Error(), FlashErr: true, Now: time.Now().UTC()})
		return
	}
	s.renderAdmin(c, adminPageData{
		Authed: true,
		Status: status,
		Keys:   items,
		Now:    time.Now().UTC(),
		Flash:  c.Query("flash"),
	})
}

func (s *Server) adminLogin(c *gin.Context) {
	token := strings.TrimSpace(c.PostForm("token"))
	if token == "" || token != s.adminToken {
		s.renderAdmin(c, adminPageData{Flash: "口令不正确"})
		return
	}
	secure := c.Request.TLS != nil
	c.SetSameSite(http.SameSiteLaxMode)
	c.SetCookie(adminCookie, token, 12*3600, "/admin", "", secure, true)
	c.Redirect(http.StatusFound, "/admin")
}

func (s *Server) adminLogout(c *gin.Context) {
	c.SetCookie(adminCookie, "", -1, "/admin", "", false, true)
	c.Redirect(http.StatusFound, "/admin")
}

func (s *Server) adminIssue(c *gin.Context) {
	if !s.requireAdminPage(c) {
		return
	}
	count, _ := strconv.Atoi(c.PostForm("count"))
	expRaw := strings.TrimSpace(c.PostForm("expiresAt"))
	var expPtr *string
	if expRaw != "" {
		expPtr = &expRaw
	}
	exp, err := parseTime(expPtr)
	if err != nil {
		c.Redirect(http.StatusFound, "/admin?flash=到期日格式不正确")
		return
	}
	out, err := s.svc.IssueKeys(c.Request.Context(), license.IssueInput{
		Count:     count,
		ExpiresAt: exp,
		IssuedTo:  ptrStr(c.PostForm("issuedTo")),
		Remark:    ptrStr(c.PostForm("remark")),
	})
	if err != nil {
		c.Redirect(http.StatusFound, "/admin?flash="+err.Error())
		return
	}
	items, _ := s.svc.ListKeys(c.Request.Context(), "")
	s.renderAdmin(c, adminPageData{Authed: true, Keys: items, Issued: out, Now: time.Now().UTC(), Flash: "已发放"})
}

func (s *Server) adminUnbind(c *gin.Context) {
	if !s.requireAdminPage(c) {
		return
	}
	id, _ := strconv.ParseInt(c.Param("id"), 10, 64)
	if err := s.svc.Unbind(c.Request.Context(), id, c.PostForm("reason"), "admin-ui"); err != nil {
		c.Redirect(http.StatusFound, "/admin?flash="+err.Error())
		return
	}
	c.Redirect(http.StatusFound, "/admin?flash=已解绑")
}

func (s *Server) adminDisable(c *gin.Context) {
	if !s.requireAdminPage(c) {
		return
	}
	id, _ := strconv.ParseInt(c.Param("id"), 10, 64)
	if err := s.svc.Disable(c.Request.Context(), id, c.PostForm("reason"), "admin-ui"); err != nil {
		c.Redirect(http.StatusFound, "/admin?flash="+err.Error())
		return
	}
	c.Redirect(http.StatusFound, "/admin?flash=已停用")
}

func mustTemplate(name, src string) *template.Template {
	return template.Must(template.New(name).Parse(src))
}
