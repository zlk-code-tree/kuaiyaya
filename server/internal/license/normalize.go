package license

import (
	"regexp"
	"strings"
	"unicode"
)

var deviceIDRe = regexp.MustCompile(DeviceIDPattern)

// NormalizeKey 去空白并统一大写。比较与入库只走规范化后的值。
func NormalizeKey(raw string) string {
	var b strings.Builder
	b.Grow(len(raw))
	for _, r := range raw {
		if unicode.IsSpace(r) {
			continue
		}
		b.WriteRune(unicode.ToUpper(r))
	}
	return b.String()
}

func ValidDeviceID(id string) bool {
	return deviceIDRe.MatchString(id)
}

func KeyPrefix(key string) string {
	if len(key) <= 9 {
		return key
	}
	return key[:9] + "…"
}
