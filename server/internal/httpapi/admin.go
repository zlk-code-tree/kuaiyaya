package httpapi

import (
	"errors"
	"log/slog"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"kuaiyaya/server/internal/license"
	"kuaiyaya/server/internal/store"
)

type adminHandler struct {
	svc *license.Service
	log *slog.Logger
}

type issueReq struct {
	Count     int     `json:"count"`
	ExpiresAt *string `json:"expiresAt"`
	IssuedTo  string  `json:"issuedTo"`
	Remark    string  `json:"remark"`
	Actor     string  `json:"actor"`
}

type reasonReq struct {
	Reason string `json:"reason"`
	Actor  string `json:"actor"`
}

type patchReq struct {
	ExpiresAt *string `json:"expiresAt"`
	IssuedTo  *string `json:"issuedTo"`
	Remark    *string `json:"remark"`
	Actor     string  `json:"actor"`
}

func parseTime(s *string) (*time.Time, error) {
	if s == nil || strings.TrimSpace(*s) == "" {
		return nil, nil
	}
	raw := strings.TrimSpace(*s)
	layouts := []string{
		time.RFC3339Nano,
		time.RFC3339,
		"2006-01-02T15:04:05.000Z",
		"2006-01-02T15:04:05Z",
		"2006-01-02",
	}
	var last error
	for _, l := range layouts {
		t, err := time.Parse(l, raw)
		if err == nil {
			u := t.UTC()
			if l == "2006-01-02" {
				// 管理端按 Asia/Shanghai 当天结束换算成 UTC。
				loc, _ := time.LoadLocation("Asia/Shanghai")
				end := time.Date(t.Year(), t.Month(), t.Day(), 23, 59, 59, 999000000, loc)
				u = end.UTC()
			}
			return &u, nil
		}
		last = err
	}
	return nil, last
}

func ptrStr(s string) *string {
	s = strings.TrimSpace(s)
	if s == "" {
		return nil
	}
	return &s
}

func (h *adminHandler) issue(c *gin.Context) {
	var req issueReq
	if err := c.ShouldBindJSON(&req); err != nil {
		writeBiz(c, license.CodeInvalidRequest, nil)
		return
	}
	exp, err := parseTime(req.ExpiresAt)
	if err != nil {
		writeBiz(c, license.CodeInvalidRequest, nil)
		return
	}
	out, err := h.svc.IssueKeys(c.Request.Context(), license.IssueInput{
		Count:     req.Count,
		ExpiresAt: exp,
		IssuedTo:  ptrStr(req.IssuedTo),
		Remark:    ptrStr(req.Remark),
	})
	if err != nil {
		writeBiz(c, license.CodeInvalidRequest, nil)
		return
	}
	items := make([]gin.H, 0, len(out))
	for _, k := range out {
		items = append(items, gin.H{
			"id":        k.ID,
			"key":       k.Key,
			"expiresAt": rfc3339Ptr(k.ExpiresAt),
			"issuedTo":  k.IssuedTo,
			"remark":    k.Remark,
		})
	}
	writeOK(c, gin.H{"keys": items})
}

func (h *adminHandler) list(c *gin.Context) {
	status := c.Query("status")
	items, err := h.svc.ListKeys(c.Request.Context(), status)
	if err != nil {
		h.log.Error("list keys", "err", err)
		writeError(c, 500, "internal_error", "internal error")
		return
	}
	out := make([]gin.H, 0, len(items))
	for _, it := range items {
		out = append(out, keyJSON(it))
	}
	writeOK(c, gin.H{"keys": out})
}

func keyJSON(it store.KeyListItem) gin.H {
	status := "active"
	if it.Status == license.StatusDisabled {
		status = "disabled"
	}
	return gin.H{
		"id":          it.ID,
		"key":         it.KeyCode,
		"status":      status,
		"statusCode":  it.Status,
		"expiresAt":   rfc3339Ptr(it.ExpiresAt),
		"issuedTo":    it.IssuedTo,
		"remark":      it.Remark,
		"deviceLabel": it.DeviceLabel,
		"boundAt":     rfc3339Ptr(it.BoundAt),
		"lastSeenAt":  rfc3339Ptr(it.LastSeenAt),
		"bound":       it.BoundAt != nil,
		"createdAt":   rfc3339(it.CreatedAt),
		"updatedAt":   rfc3339(it.UpdatedAt),
	}
}

func (h *adminHandler) unbind(c *gin.Context) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil || id <= 0 {
		writeBiz(c, license.CodeInvalidRequest, nil)
		return
	}
	var req reasonReq
	_ = c.ShouldBindJSON(&req)
	if err := h.svc.Unbind(c.Request.Context(), id, req.Reason, req.Actor); err != nil {
		if errors.Is(err, license.ErrNotFound) {
			writeError(c, 404, "not_found", "key not found")
			return
		}
		h.log.Error("unbind", "err", err)
		writeError(c, 500, "internal_error", "internal error")
		return
	}
	writeOK(c, gin.H{"unbound": true})
}

func (h *adminHandler) disable(c *gin.Context) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil || id <= 0 {
		writeBiz(c, license.CodeInvalidRequest, nil)
		return
	}
	var req reasonReq
	_ = c.ShouldBindJSON(&req)
	if err := h.svc.Disable(c.Request.Context(), id, req.Reason, req.Actor); err != nil {
		if errors.Is(err, license.ErrNotFound) {
			writeError(c, 404, "not_found", "key not found")
			return
		}
		h.log.Error("disable", "err", err)
		writeError(c, 500, "internal_error", "internal error")
		return
	}
	writeOK(c, gin.H{"disabled": true})
}

func (h *adminHandler) patch(c *gin.Context) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil || id <= 0 {
		writeBiz(c, license.CodeInvalidRequest, nil)
		return
	}
	var req patchReq
	if err := c.ShouldBindJSON(&req); err != nil {
		writeBiz(c, license.CodeInvalidRequest, nil)
		return
	}
	exp, err := parseTime(req.ExpiresAt)
	if err != nil {
		writeBiz(c, license.CodeInvalidRequest, nil)
		return
	}
	in := license.PatchInput{IssuedTo: req.IssuedTo, Remark: req.Remark}
	if req.ExpiresAt != nil && strings.TrimSpace(*req.ExpiresAt) == "" {
		in.ClearExp = true
	} else {
		in.ExpiresAt = exp
	}
	if err := h.svc.PatchKey(c.Request.Context(), id, in); err != nil {
		if errors.Is(err, license.ErrNotFound) {
			writeError(c, 404, "not_found", "key not found")
			return
		}
		writeError(c, 500, "internal_error", "internal error")
		return
	}
	writeOK(c, gin.H{"updated": true})
}
