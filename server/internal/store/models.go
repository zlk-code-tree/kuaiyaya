package store

import "time"

type LicenseKey struct {
	ID        int64
	KeyCode   string
	Status    uint8
	ExpiresAt *time.Time
	IssuedTo  *string
	Remark    *string
	CreatedAt time.Time
	UpdatedAt time.Time
}

type Binding struct {
	ID                 int64
	KeyID              int64
	DeviceFingerprint  string
	DeviceLabel        *string
	BoundAt            time.Time
	LastSeenAt         *time.Time
	BoundKeyCode       string // 联查得到，便于比较规范化后的 key_code
}

type AuditLog struct {
	KeyID              int64
	KeyCode            string
	DeviceFingerprint  string
	EventType          string
	ResultCode         string
	Detail             string
	CreatedAt          time.Time
}

type UniqueConflict struct {
	Index string // "uk_key_id" 或 "uk_device_fingerprint" 或未知
}

func (e UniqueConflict) Error() string {
	if e.Index == "" {
		return "unique constraint conflict"
	}
	return "unique constraint conflict: " + e.Index
}

type KeyFilter struct {
	Status string // active|expired|disabled|bound|unbound 或空
}

type KeyListItem struct {
	LicenseKey
	DeviceLabel *string
	BoundAt     *time.Time
	LastSeenAt  *time.Time
	Fingerprint *string
}
