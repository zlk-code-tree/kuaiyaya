package license

import (
	"crypto/rand"
	"fmt"
	"io"
	"strings"
)

// Crockford Base32，去掉 I、L、O、U，与 key-service-plan 第 5.6 节一致。
const crockford = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

// GenerateKey 生成 KYDY-XXXX-XXXX-XXXX（12 个有效字符）。
func GenerateKey() (string, error) {
	return generateKey(rand.Reader)
}

func generateKey(r io.Reader) (string, error) {
	buf := make([]byte, 12)
	if _, err := io.ReadFull(r, buf); err != nil {
		return "", fmt.Errorf("generate key: %w", err)
	}
	chars := make([]byte, 12)
	for i, b := range buf {
		chars[i] = crockford[int(b)%len(crockford)]
	}
	s := string(chars)
	return "KYDY-" + s[0:4] + "-" + s[4:8] + "-" + s[8:12], nil
}

func LooksLikeKey(key string) bool {
	key = NormalizeKey(key)
	if !strings.HasPrefix(key, "KYDY-") {
		return len(key) > 0 && len(key) <= 64
	}
	return len(key) <= 64
}
