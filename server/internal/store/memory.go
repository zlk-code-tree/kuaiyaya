package store

import (
	"context"
	"fmt"
	"sync"
	"time"
)

// Memory 是用于单测的内存库，模拟三张表的唯一约束。不用于生产。
type Memory struct {
	mu      sync.Mutex
	nextID  int64
	keys    map[int64]LicenseKey
	byCode  map[string]int64
	binds   map[int64]Binding
	byFP    map[string]int64
	byKeyID map[int64]int64
	audits  []AuditLog
}

func NewMemory() *Memory {
	return &Memory{
		keys:    map[int64]LicenseKey{},
		byCode:  map[string]int64{},
		binds:   map[int64]Binding{},
		byFP:    map[string]int64{},
		byKeyID: map[int64]int64{},
	}
}

func (m *Memory) Audits() []AuditLog {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]AuditLog, len(m.audits))
	copy(out, m.audits)
	return out
}

func (m *Memory) WithTx(ctx context.Context, fn func(Tx) error) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	return fn(&memoryTx{m: m})
}

func (m *Memory) InsertAudit(_ context.Context, log AuditLog) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.audits = append(m.audits, log)
	return nil
}

func (m *Memory) Ping(context.Context) error { return nil }
func (m *Memory) Close() error              { return nil }

func (m *Memory) alloc() int64 {
	m.nextID++
	return m.nextID
}

type memoryTx struct{ m *Memory }

func (t *memoryTx) GetBindingByFingerprint(_ context.Context, fp string) (*Binding, error) {
	id, ok := t.m.byFP[fp]
	if !ok {
		return nil, nil
	}
	b := t.m.binds[id]
	if k, ok := t.m.keys[b.KeyID]; ok {
		b.BoundKeyCode = k.KeyCode
	}
	cp := b
	return &cp, nil
}

func (t *memoryTx) GetBindingByKeyID(_ context.Context, keyID int64) (*Binding, error) {
	id, ok := t.m.byKeyID[keyID]
	if !ok {
		return nil, nil
	}
	b := t.m.binds[id]
	if k, ok := t.m.keys[b.KeyID]; ok {
		b.BoundKeyCode = k.KeyCode
	}
	cp := b
	return &cp, nil
}

func (t *memoryTx) LockKeyByCode(_ context.Context, keyCode string) (*LicenseKey, error) {
	id, ok := t.m.byCode[keyCode]
	if !ok {
		return nil, nil
	}
	k := t.m.keys[id]
	cp := k
	return &cp, nil
}

func (t *memoryTx) LockKeyByID(_ context.Context, id int64) (*LicenseKey, error) {
	k, ok := t.m.keys[id]
	if !ok {
		return nil, nil
	}
	cp := k
	return &cp, nil
}

func (t *memoryTx) InsertBinding(_ context.Context, b Binding) (int64, error) {
	if _, ok := t.m.byKeyID[b.KeyID]; ok {
		return 0, UniqueConflict{Index: "uk_key_id"}
	}
	if _, ok := t.m.byFP[b.DeviceFingerprint]; ok {
		return 0, UniqueConflict{Index: "uk_device_fingerprint"}
	}
	id := t.m.alloc()
	b.ID = id
	t.m.binds[id] = b
	t.m.byKeyID[b.KeyID] = id
	t.m.byFP[b.DeviceFingerprint] = id
	return id, nil
}

func (t *memoryTx) UpdateLastSeen(_ context.Context, bindingID int64, at time.Time) error {
	b, ok := t.m.binds[bindingID]
	if !ok {
		return fmt.Errorf("binding %d not found", bindingID)
	}
	b.LastSeenAt = &at
	t.m.binds[bindingID] = b
	return nil
}

func (t *memoryTx) UpdateDeviceLabel(_ context.Context, bindingID int64, label *string) error {
	b, ok := t.m.binds[bindingID]
	if !ok {
		return fmt.Errorf("binding %d not found", bindingID)
	}
	b.DeviceLabel = label
	t.m.binds[bindingID] = b
	return nil
}

func (t *memoryTx) DeleteBindingByKeyID(_ context.Context, keyID int64) (*Binding, error) {
	id, ok := t.m.byKeyID[keyID]
	if !ok {
		return nil, nil
	}
	b := t.m.binds[id]
	delete(t.m.binds, id)
	delete(t.m.byKeyID, keyID)
	delete(t.m.byFP, b.DeviceFingerprint)
	cp := b
	return &cp, nil
}

func (t *memoryTx) InsertKey(_ context.Context, k LicenseKey) (int64, error) {
	if _, ok := t.m.byCode[k.KeyCode]; ok {
		return 0, UniqueConflict{Index: "uk_key_code"}
	}
	id := t.m.alloc()
	k.ID = id
	t.m.keys[id] = k
	t.m.byCode[k.KeyCode] = id
	return id, nil
}

func (t *memoryTx) UpdateKey(_ context.Context, k LicenseKey) error {
	old, ok := t.m.keys[k.ID]
	if !ok {
		return fmt.Errorf("key %d not found", k.ID)
	}
	k.KeyCode = old.KeyCode // 不允许改码
	t.m.keys[k.ID] = k
	return nil
}

func (t *memoryTx) ListKeys(_ context.Context, filter KeyFilter, now time.Time) ([]KeyListItem, error) {
	out := make([]KeyListItem, 0, len(t.m.keys))
	for _, k := range t.m.keys {
		item := KeyListItem{LicenseKey: k}
		if bid, ok := t.m.byKeyID[k.ID]; ok {
			b := t.m.binds[bid]
			item.DeviceLabel = b.DeviceLabel
			item.BoundAt = &b.BoundAt
			item.LastSeenAt = b.LastSeenAt
			fp := b.DeviceFingerprint
			item.Fingerprint = &fp
		}
		if matchFilter(item, filter, now) {
			out = append(out, item)
		}
	}
	return out, nil
}

func matchFilter(item KeyListItem, filter KeyFilter, now time.Time) bool {
	switch filter.Status {
	case "", "all":
		return true
	case "active":
		return item.Status == 1 && (item.ExpiresAt == nil || now.Before(*item.ExpiresAt))
	case "expired":
		return item.ExpiresAt != nil && !now.Before(*item.ExpiresAt)
	case "disabled":
		return item.Status == 2
	case "bound":
		return item.BoundAt != nil
	case "unbound":
		return item.BoundAt == nil
	default:
		return true
	}
}
