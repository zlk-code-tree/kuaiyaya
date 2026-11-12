package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/go-sql-driver/mysql"
)

type MySQL struct {
	DB *sql.DB
}

func OpenMySQL(dsn string) (*MySQL, error) {
	db, err := sql.Open("mysql", dsn)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(16)
	db.SetMaxIdleConns(8)
	db.SetConnMaxLifetime(30 * time.Minute)
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	if err := db.PingContext(ctx); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("ping mysql: %w", err)
	}
	return &MySQL{DB: db}, nil
}

func (m *MySQL) Ping(ctx context.Context) error {
	return m.DB.PingContext(ctx)
}

func (m *MySQL) Close() error { return m.DB.Close() }

func (m *MySQL) WithTx(ctx context.Context, fn func(Tx) error) error {
	tx, err := m.DB.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelReadCommitted})
	if err != nil {
		return err
	}
	defer func() {
		if p := recover(); p != nil {
			_ = tx.Rollback()
			panic(p)
		}
	}()
	if err := fn(&mysqlTx{tx: tx}); err != nil {
		_ = tx.Rollback()
		return err
	}
	return tx.Commit()
}

func (m *MySQL) InsertAudit(ctx context.Context, log AuditLog) error {
	_, err := m.DB.ExecContext(ctx, `
		INSERT INTO binding_audit_logs
			(key_id, key_code, device_fingerprint, event_type, result_code, detail, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?)`,
		log.KeyID, log.KeyCode, log.DeviceFingerprint, log.EventType, nullStr(log.ResultCode), nullStr(log.Detail), log.CreatedAt,
	)
	return err
}

type mysqlTx struct{ tx *sql.Tx }

func (t *mysqlTx) GetBindingByFingerprint(ctx context.Context, fp string) (*Binding, error) {
	row := t.tx.QueryRowContext(ctx, `
		SELECT b.id, b.key_id, b.device_fingerprint, b.device_label, b.bound_at, b.last_seen_at, k.key_code
		FROM device_bindings b
		JOIN license_keys k ON k.id = b.key_id
		WHERE b.device_fingerprint = ?
		FOR UPDATE`, fp)
	return scanBinding(row)
}

func (t *mysqlTx) GetBindingByKeyID(ctx context.Context, keyID int64) (*Binding, error) {
	row := t.tx.QueryRowContext(ctx, `
		SELECT b.id, b.key_id, b.device_fingerprint, b.device_label, b.bound_at, b.last_seen_at, k.key_code
		FROM device_bindings b
		JOIN license_keys k ON k.id = b.key_id
		WHERE b.key_id = ?
		FOR UPDATE`, keyID)
	return scanBinding(row)
}

func (t *mysqlTx) LockKeyByCode(ctx context.Context, keyCode string) (*LicenseKey, error) {
	row := t.tx.QueryRowContext(ctx, `
		SELECT id, key_code, status, expires_at, issued_to, remark, created_at, updated_at
		FROM license_keys WHERE key_code = ? FOR UPDATE`, keyCode)
	return scanKey(row)
}

func (t *mysqlTx) LockKeyByID(ctx context.Context, id int64) (*LicenseKey, error) {
	row := t.tx.QueryRowContext(ctx, `
		SELECT id, key_code, status, expires_at, issued_to, remark, created_at, updated_at
		FROM license_keys WHERE id = ? FOR UPDATE`, id)
	return scanKey(row)
}

func (t *mysqlTx) InsertBinding(ctx context.Context, b Binding) (int64, error) {
	res, err := t.tx.ExecContext(ctx, `
		INSERT INTO device_bindings (key_id, device_fingerprint, device_label, bound_at, last_seen_at)
		VALUES (?, ?, ?, ?, ?)`,
		b.KeyID, b.DeviceFingerprint, b.DeviceLabel, b.BoundAt, b.LastSeenAt,
	)
	if err != nil {
		return 0, mapMySQLErr(err)
	}
	return res.LastInsertId()
}

func (t *mysqlTx) UpdateLastSeen(ctx context.Context, bindingID int64, at time.Time) error {
	_, err := t.tx.ExecContext(ctx, `UPDATE device_bindings SET last_seen_at = ? WHERE id = ?`, at, bindingID)
	return err
}

func (t *mysqlTx) UpdateDeviceLabel(ctx context.Context, bindingID int64, label *string) error {
	_, err := t.tx.ExecContext(ctx, `UPDATE device_bindings SET device_label = ? WHERE id = ?`, label, bindingID)
	return err
}

func (t *mysqlTx) DeleteBindingByKeyID(ctx context.Context, keyID int64) (*Binding, error) {
	b, err := t.GetBindingByKeyID(ctx, keyID)
	if err != nil || b == nil {
		return b, err
	}
	if _, err := t.tx.ExecContext(ctx, `DELETE FROM device_bindings WHERE key_id = ?`, keyID); err != nil {
		return nil, err
	}
	return b, nil
}

func (t *mysqlTx) InsertKey(ctx context.Context, k LicenseKey) (int64, error) {
	res, err := t.tx.ExecContext(ctx, `
		INSERT INTO license_keys (key_code, status, expires_at, issued_to, remark, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?)`,
		k.KeyCode, k.Status, k.ExpiresAt, k.IssuedTo, k.Remark, k.CreatedAt, k.UpdatedAt,
	)
	if err != nil {
		return 0, mapMySQLErr(err)
	}
	return res.LastInsertId()
}

func (t *mysqlTx) UpdateKey(ctx context.Context, k LicenseKey) error {
	_, err := t.tx.ExecContext(ctx, `
		UPDATE license_keys
		SET status = ?, expires_at = ?, issued_to = ?, remark = ?, updated_at = ?
		WHERE id = ?`,
		k.Status, k.ExpiresAt, k.IssuedTo, k.Remark, k.UpdatedAt, k.ID,
	)
	return err
}

func (t *mysqlTx) ListKeys(ctx context.Context, filter KeyFilter, now time.Time) ([]KeyListItem, error) {
	rows, err := t.tx.QueryContext(ctx, `
		SELECT k.id, k.key_code, k.status, k.expires_at, k.issued_to, k.remark, k.created_at, k.updated_at,
		       b.device_label, b.bound_at, b.last_seen_at, b.device_fingerprint
		FROM license_keys k
		LEFT JOIN device_bindings b ON b.key_id = k.id
		ORDER BY k.id DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []KeyListItem
	for rows.Next() {
		var item KeyListItem
		var exp, boundAt, lastSeen sql.NullTime
		var issued, remark, label, fp sql.NullString
		if err := rows.Scan(
			&item.ID, &item.KeyCode, &item.Status, &exp, &issued, &remark, &item.CreatedAt, &item.UpdatedAt,
			&label, &boundAt, &lastSeen, &fp,
		); err != nil {
			return nil, err
		}
		if exp.Valid {
			t := exp.Time.UTC()
			item.ExpiresAt = &t
		}
		if issued.Valid {
			item.IssuedTo = &issued.String
		}
		if remark.Valid {
			item.Remark = &remark.String
		}
		if label.Valid {
			item.DeviceLabel = &label.String
		}
		if boundAt.Valid {
			t := boundAt.Time.UTC()
			item.BoundAt = &t
		}
		if lastSeen.Valid {
			t := lastSeen.Time.UTC()
			item.LastSeenAt = &t
		}
		if fp.Valid {
			item.Fingerprint = &fp.String
		}
		if matchFilter(item, filter, now) {
			out = append(out, item)
		}
	}
	return out, rows.Err()
}

func scanKey(row *sql.Row) (*LicenseKey, error) {
	var k LicenseKey
	var exp sql.NullTime
	var issued, remark sql.NullString
	err := row.Scan(&k.ID, &k.KeyCode, &k.Status, &exp, &issued, &remark, &k.CreatedAt, &k.UpdatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	k.CreatedAt = k.CreatedAt.UTC()
	k.UpdatedAt = k.UpdatedAt.UTC()
	if exp.Valid {
		t := exp.Time.UTC()
		k.ExpiresAt = &t
	}
	if issued.Valid {
		k.IssuedTo = &issued.String
	}
	if remark.Valid {
		k.Remark = &remark.String
	}
	return &k, nil
}

func scanBinding(row *sql.Row) (*Binding, error) {
	var b Binding
	var label sql.NullString
	var last sql.NullTime
	err := row.Scan(&b.ID, &b.KeyID, &b.DeviceFingerprint, &label, &b.BoundAt, &last, &b.BoundKeyCode)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	b.BoundAt = b.BoundAt.UTC()
	if label.Valid {
		b.DeviceLabel = &label.String
	}
	if last.Valid {
		t := last.Time.UTC()
		b.LastSeenAt = &t
	}
	return &b, nil
}

func mapMySQLErr(err error) error {
	var me *mysql.MySQLError
	if errors.As(err, &me) && me.Number == 1062 {
		msg := strings.ToLower(me.Message)
		switch {
		case strings.Contains(msg, "uk_device_fingerprint"):
			return UniqueConflict{Index: "uk_device_fingerprint"}
		case strings.Contains(msg, "uk_key_id"):
			return UniqueConflict{Index: "uk_key_id"}
		case strings.Contains(msg, "uk_key_code"):
			return UniqueConflict{Index: "uk_key_code"}
		default:
			return UniqueConflict{Index: "unknown"}
		}
	}
	return err
}

func nullStr(s string) any {
	if s == "" {
		return nil
	}
	return s
}

func MapMySQLErr(err error) error { return mapMySQLErr(err) }
