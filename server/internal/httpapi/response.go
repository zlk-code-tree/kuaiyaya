package httpapi

import (
	"log/slog"
	"time"

	"github.com/gin-gonic/gin"

	"kuaiyaya/server/internal/license"
)

type envelope struct {
	OK    bool        `json:"ok"`
	Data  any         `json:"data,omitempty"`
	Error *errBody    `json:"error,omitempty"`
}

type errBody struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

func writeOK(c *gin.Context, data any) {
	c.JSON(200, envelope{OK: true, Data: data})
}

func writeBiz(c *gin.Context, code string, extra map[string]any) {
	status := license.HTTPStatus(code)
	body := envelope{OK: false, Error: &errBody{Code: code, Message: license.DevMessage(code)}}
	if extra != nil {
		// 失败时不把业务成功字段塞进 data，保持契约干净。
	}
	c.JSON(status, body)
}

func writeError(c *gin.Context, status int, code, msg string) {
	c.JSON(status, envelope{OK: false, Error: &errBody{Code: code, Message: msg}})
}

func rfc3339(t time.Time) string {
	return t.UTC().Format("2006-01-02T15:04:05.000Z")
}

func rfc3339Ptr(t *time.Time) any {
	if t == nil {
		return nil
	}
	return rfc3339(*t)
}

func logLicense(lg *slog.Logger, action, code, key, deviceID string) {
	if lg == nil {
		return
	}
	lg.Info("license",
		"action", action,
		"code", code,
		"keyPrefix", license.KeyPrefix(license.NormalizeKey(key)),
		"deviceId", deviceID,
	)
}
