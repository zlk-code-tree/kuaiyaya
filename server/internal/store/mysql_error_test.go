package store

import (
	"testing"

	"github.com/go-sql-driver/mysql"
)

func TestMapMySQLUniqueConflicts(t *testing.T) {
	cases := []struct {
		msg   string
		index string
	}{
		{"Duplicate entry 'abc' for key 'device_bindings.uk_device_fingerprint'", "uk_device_fingerprint"},
		{"Duplicate entry '1' for key 'uk_key_id'", "uk_key_id"},
		{"Duplicate entry 'KYDY-XXXX' for key 'uk_key_code'", "uk_key_code"},
	}
	for _, c := range cases {
		err := MapMySQLErr(&mysql.MySQLError{Number: 1062, Message: c.msg})
		u, ok := err.(UniqueConflict)
		if !ok {
			t.Fatalf("want UniqueConflict for %s, got %T %v", c.msg, err, err)
		}
		if u.Index != c.index {
			t.Fatalf("want index %s, got %s", c.index, u.Index)
		}
	}
}
