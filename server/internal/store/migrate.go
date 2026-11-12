package store

import (
	"context"
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
)

func Migrate(ctx context.Context, db *sql.DB, sqlFile string) error {
	body, err := os.ReadFile(sqlFile)
	if err != nil {
		return fmt.Errorf("read migration %s: %w", sqlFile, err)
	}
	// 简单按分号拆分，本迁移文件没有存储过程。
	stmts := splitSQL(string(body))
	for _, s := range stmts {
		if _, err := db.ExecContext(ctx, s); err != nil {
			return fmt.Errorf("migrate exec: %w\n---\n%s", err, s)
		}
	}
	return nil
}

func FindMigrationFile(explicit string) (string, error) {
	if explicit != "" {
		return explicit, nil
	}
	candidates := []string{
		"migrations/001_init.sql",
		filepath.Join("server", "migrations", "001_init.sql"),
	}
	if exe, err := os.Executable(); err == nil {
		dir := filepath.Dir(exe)
		candidates = append(candidates,
			filepath.Join(dir, "migrations", "001_init.sql"),
			filepath.Join(dir, "..", "migrations", "001_init.sql"),
		)
	}
	for _, c := range candidates {
		if _, err := os.Stat(c); err == nil {
			abs, _ := filepath.Abs(c)
			return abs, nil
		}
	}
	return "", fmt.Errorf("找不到 migrations/001_init.sql")
}

func splitSQL(s string) []string {
	var out []string
	var cur []rune
	for _, r := range s {
		if r == ';' {
			stmt := trimSQL(string(cur))
			if stmt != "" {
				out = append(out, stmt)
			}
			cur = cur[:0]
			continue
		}
		cur = append(cur, r)
	}
	if stmt := trimSQL(string(cur)); stmt != "" {
		out = append(out, stmt)
	}
	return out
}

func trimSQL(s string) string {
	lines := splitLines(s)
	var kept []string
	for _, ln := range lines {
		t := trimSpace(ln)
		if t == "" || len(t) >= 2 && t[0] == '-' && t[1] == '-' {
			continue
		}
		kept = append(kept, ln)
	}
	return trimSpace(join(kept, "\n"))
}

func splitLines(s string) []string {
	var lines []string
	start := 0
	for i, r := range s {
		if r == '\n' {
			lines = append(lines, s[start:i])
			start = i + 1
		}
	}
	lines = append(lines, s[start:])
	return lines
}

func trimSpace(s string) string {
	i, j := 0, len(s)
	for i < j && (s[i] == ' ' || s[i] == '\n' || s[i] == '\r' || s[i] == '\t') {
		i++
	}
	for j > i && (s[j-1] == ' ' || s[j-1] == '\n' || s[j-1] == '\r' || s[j-1] == '\t') {
		j--
	}
	return s[i:j]
}

func join(a []string, sep string) string {
	if len(a) == 0 {
		return ""
	}
	n := len(sep) * (len(a) - 1)
	for _, s := range a {
		n += len(s)
	}
	b := make([]byte, 0, n)
	for i, s := range a {
		if i > 0 {
			b = append(b, sep...)
		}
		b = append(b, s...)
	}
	return string(b)
}
