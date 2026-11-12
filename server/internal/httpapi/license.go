package httpapi

import (
	"log/slog"

	"github.com/gin-gonic/gin"

	"kuaiyaya/server/internal/license"
)

type licenseHandler struct {
	svc *license.Service
	log *slog.Logger
}

type activateReq struct {
	Key         string `json:"key"`
	DeviceID    string `json:"deviceId"`
	AppVersion  string `json:"appVersion"`
	Platform    string `json:"platform"`
	Arch        string `json:"arch"`
	DeviceLabel string `json:"deviceLabel"`
}

type validateReq struct {
	Key        string `json:"key"`
	DeviceID   string `json:"deviceId"`
	AppVersion string `json:"appVersion"`
}

func (h *licenseHandler) activate(c *gin.Context) {
	var req activateReq
	if err := c.ShouldBindJSON(&req); err != nil {
		writeBiz(c, license.CodeInvalidRequest, nil)
		return
	}
	var label *string
	if req.DeviceLabel != "" {
		// 禁止把明文硬件序列号当展示名；这里只做长度限制，不参与匹配。
		l := req.DeviceLabel
		if len(l) > 255 {
			l = l[:255]
		}
		if req.Platform != "" || req.Arch != "" || req.AppVersion != "" {
			l = l + " (" + req.Platform + "/" + req.Arch + " " + req.AppVersion + ")"
			if len(l) > 255 {
				l = l[:255]
			}
		}
		label = &l
	}
	res, err := h.svc.Check(c.Request.Context(), license.CheckInput{
		Key:         req.Key,
		DeviceID:    req.DeviceID,
		DeviceLabel: label,
		Mode:        license.ModeActivate,
	})
	if err != nil {
		h.log.Error("activate failed", "err", err)
		writeError(c, 500, "internal_error", "internal error")
		return
	}
	logLicense(h.log, "activate", res.Code, req.Key, req.DeviceID)
	if !res.OK() {
		writeBiz(c, res.Code, nil)
		return
	}
	writeOK(c, gin.H{
		"expiresAt":  rfc3339Ptr(res.ExpiresAt),
		"serverTime": rfc3339(res.ServerNow),
	})
}

func (h *licenseHandler) validate(c *gin.Context) {
	var req validateReq
	if err := c.ShouldBindJSON(&req); err != nil {
		writeBiz(c, license.CodeInvalidRequest, nil)
		return
	}
	res, err := h.svc.Check(c.Request.Context(), license.CheckInput{
		Key:      req.Key,
		DeviceID: req.DeviceID,
		Mode:     license.ModeSilent,
	})
	if err != nil {
		h.log.Error("validate failed", "err", err)
		writeError(c, 500, "internal_error", "internal error")
		return
	}
	logLicense(h.log, "validate", res.Code, req.Key, req.DeviceID)
	if !res.OK() {
		writeBiz(c, res.Code, nil)
		return
	}
	writeOK(c, gin.H{
		"expiresAt":  rfc3339Ptr(res.ExpiresAt),
		"serverTime": rfc3339(res.ServerNow),
	})
}
