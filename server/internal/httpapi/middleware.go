package httpapi

import (
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"

	"kuaiyaya/server/internal/license"
)

func adminAuth(token string) gin.HandlerFunc {
	return func(c *gin.Context) {
		got := bearer(c.GetHeader("Authorization"))
		if got == "" {
			got = c.Query("token")
		}
		if token == "" || got != token {
			writeError(c, http.StatusUnauthorized, license.CodeAdminUnauthorized, license.DevMessage(license.CodeAdminUnauthorized))
			c.Abort()
			return
		}
		c.Next()
	}
}

func bearer(h string) string {
	const p = "Bearer "
	if strings.HasPrefix(h, p) {
		return strings.TrimSpace(h[len(p):])
	}
	return ""
}

// 简易固定窗口限流：激活每 IP 每分钟 10 次，校验每分钟 30 次，超限 429。
type limiter struct {
	mu      sync.Mutex
	window  time.Duration
	limit   int
	hits    map[string][]time.Time
}

func newLimiter(limit int, window time.Duration) *limiter {
	return &limiter{window: window, limit: limit, hits: map[string][]time.Time{}}
}

func (l *limiter) allow(key string, now time.Time) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	cut := now.Add(-l.window)
	arr := l.hits[key]
	n := 0
	for _, t := range arr {
		if t.After(cut) {
			arr[n] = t
			n++
		}
	}
	arr = arr[:n]
	if len(arr) >= l.limit {
		l.hits[key] = arr
		return false
	}
	l.hits[key] = append(arr, now)
	return true
}

func rateLimit(l *limiter) gin.HandlerFunc {
	return func(c *gin.Context) {
		if !l.allow(c.ClientIP(), time.Now()) {
			c.Status(http.StatusTooManyRequests)
			c.Header("Retry-After", "60")
			c.Abort()
			return
		}
		c.Next()
	}
}
