package store

import (
	"context"
	"time"
)

// Tx 是同一事务内的读改接口。调用方必须按判定顺序在同一事务里完成。
type Tx interface {
	GetBindingByFingerprint(ctx context.Context, fp string) (*Binding, error)
	GetBindingByKeyID(ctx context.Context, keyID int64) (*Binding, error)
	LockKeyByCode(ctx context.Context, keyCode string) (*LicenseKey, error)
	LockKeyByID(ctx context.Context, id int64) (*LicenseKey, error)
	InsertBinding(ctx context.Context, b Binding) (int64, error)
	UpdateLastSeen(ctx context.Context, bindingID int64, at time.Time) error
	UpdateDeviceLabel(ctx context.Context, bindingID int64, label *string) error
	DeleteBindingByKeyID(ctx context.Context, keyID int64) (*Binding, error)

	InsertKey(ctx context.Context, k LicenseKey) (int64, error)
	UpdateKey(ctx context.Context, k LicenseKey) error
	ListKeys(ctx context.Context, filter KeyFilter, now time.Time) ([]KeyListItem, error)
}

type Store interface {
	WithTx(ctx context.Context, fn func(Tx) error) error
	InsertAudit(ctx context.Context, log AuditLog) error
	Ping(ctx context.Context) error
	Close() error
}
