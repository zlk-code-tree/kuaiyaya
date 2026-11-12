package license

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"kuaiyaya/server/internal/store"
)

type Clock func() time.Time

type Service struct {
	Store store.Store
	Now   Clock
}

func NewService(s store.Store) *Service {
	return &Service{Store: s, Now: func() time.Time { return time.Now().UTC() }}
}

func (s *Service) now() time.Time {
	if s.Now != nil {
		return s.Now().UTC()
	}
	return time.Now().UTC()
}

type CheckInput struct {
	Key         string
	DeviceID    string
	DeviceLabel *string
	Mode        Mode
}

type CheckResult struct {
	Code      string
	ExpiresAt *time.Time
	ServerNow time.Time
}

func (r CheckResult) OK() bool { return r.Code == CodeOK }

// Check 按 key-service-plan 第 5.1 节顺序判定。activate 才会绑定，silent 绝不插入绑定。
func (s *Service) Check(ctx context.Context, in CheckInput) (CheckResult, error) {
	now := s.now()
	res := CheckResult{ServerNow: now}

	key := NormalizeKey(in.Key)
	if key == "" || !ValidDeviceID(in.DeviceID) {
		res.Code = CodeInvalidRequest
		return res, nil
	}
	if in.Mode != ModeActivate && in.Mode != ModeSilent {
		res.Code = CodeInvalidRequest
		return res, nil
	}

	var (
		code   string
		exp    *time.Time
		audit  *store.AuditLog
		keyID  int64
		detail string
	)

	err := s.Store.WithTx(ctx, func(tx store.Tx) error {
		deviceBind, err := tx.GetBindingByFingerprint(ctx, in.DeviceID)
		if err != nil {
			return err
		}

		// 1. 本指纹已绑定其他 Key（即便本次输入的 Key 无效或过期，也先返回这个）。
		if deviceBind != nil && deviceBind.BoundKeyCode != key {
			code = CodeDeviceBoundToOtherKey
			keyID = deviceBind.KeyID
			detail = "设备已绑定其他 Key"
			audit = failAudit(keyID, key, in.DeviceID, code, detail, now)
			return nil
		}

		lic, err := tx.LockKeyByCode(ctx, key)
		if err != nil {
			return err
		}

		// 2. Key 不存在，或已停用 → invalid
		if lic == nil || lic.Status != StatusActive {
			code = CodeInvalid
			if lic != nil {
				keyID = lic.ID
				exp = lic.ExpiresAt
			}
			detail = "Key 不存在或已停用"
			audit = failAudit(keyID, key, in.DeviceID, code, detail, now)
			return nil
		}
		keyID = lic.ID
		exp = lic.ExpiresAt

		// 3. 已过期（now >= expires_at）
		if lic.ExpiresAt != nil && !now.Before(*lic.ExpiresAt) {
			code = CodeExpired
			// 已绑本设备则保留绑定、不更新 last_seen_at；未绑则不插入。
			detail = "Key 已过期"
			audit = failAudit(keyID, key, in.DeviceID, code, detail, now)
			return nil
		}

		keyBind, err := tx.GetBindingByKeyID(ctx, lic.ID)
		if err != nil {
			return err
		}

		// 4. 本 Key 已绑定其他指纹
		if keyBind != nil && keyBind.DeviceFingerprint != in.DeviceID {
			code = CodeKeyBoundToOtherDevice
			detail = "该 Key 已绑定其他设备"
			audit = failAudit(keyID, key, in.DeviceID, code, detail, now)
			return nil
		}

		// 5. 已绑定本设备且未过期 → 更新 last_seen_at，返回 ok
		if deviceBind != nil && deviceBind.BoundKeyCode == key && keyBind != nil && keyBind.DeviceFingerprint == in.DeviceID {
			if err := tx.UpdateLastSeen(ctx, deviceBind.ID, now); err != nil {
				return err
			}
			if in.DeviceLabel != nil && in.Mode == ModeActivate {
				_ = tx.UpdateDeviceLabel(ctx, deviceBind.ID, in.DeviceLabel)
			}
			code = CodeOK
			audit = &store.AuditLog{
				KeyID:             keyID,
				KeyCode:           key,
				DeviceFingerprint: in.DeviceID,
				EventType:         EventValidateOK,
				ResultCode:        CodeOK,
				Detail:            "已绑定本设备，更新最近校验时间",
				CreatedAt:         now,
			}
			return nil
		}

		// 6. 两边都无绑定，且 Key 启用未过期
		if deviceBind == nil && keyBind == nil {
			if in.Mode == ModeSilent {
				code = CodeNotBound
				detail = "静默校验不自动绑定"
				audit = failAudit(keyID, key, in.DeviceID, code, detail, now)
				return nil
			}
			_, err := tx.InsertBinding(ctx, store.Binding{
				KeyID:             lic.ID,
				DeviceFingerprint: in.DeviceID,
				DeviceLabel:       in.DeviceLabel,
				BoundAt:           now,
				LastSeenAt:        &now,
			})
			if err != nil {
				var conflict store.UniqueConflict
				if errors.As(err, &conflict) {
					code, detail = translateConflict(conflict)
					audit = failAudit(keyID, key, in.DeviceID, code, detail, now)
					return nil
				}
				return err
			}
			code = CodeOK
			audit = &store.AuditLog{
				KeyID:             keyID,
				KeyCode:           key,
				DeviceFingerprint: in.DeviceID,
				EventType:         EventBind,
				ResultCode:        CodeOK,
				Detail:            "首次激活绑定",
				CreatedAt:         now,
			}
			return nil
		}

		// 理论上不会走到这里：一边有绑定却没被 1/4/5 接住。
		code = CodeInvalidRequest
		detail = "绑定状态不一致"
		audit = failAudit(keyID, key, in.DeviceID, code, detail, now)
		return nil
	})
	if err != nil {
		return res, err
	}

	res.Code = code
	if code == CodeOK {
		res.ExpiresAt = exp
	} else if code == CodeExpired {
		res.ExpiresAt = exp
	}

	if audit != nil {
		if aerr := s.Store.InsertAudit(ctx, *audit); aerr != nil {
			// 审计失败不得回滚已经成功的绑定/校验事务。
			fmt.Printf("audit insert failed: %v\n", aerr)
		}
	}
	return res, nil
}

func failAudit(keyID int64, key, fp, code, detail string, now time.Time) *store.AuditLog {
	return &store.AuditLog{
		KeyID:             keyID,
		KeyCode:           key,
		DeviceFingerprint: fp,
		EventType:         EventValidateFail,
		ResultCode:        code,
		Detail:            detail,
		CreatedAt:         now,
	}
}

func translateConflict(c store.UniqueConflict) (code, detail string) {
	switch c.Index {
	case "uk_device_fingerprint":
		return CodeDeviceBoundToOtherKey, "并发绑定：设备唯一约束冲突"
	case "uk_key_id":
		return CodeKeyBoundToOtherDevice, "并发绑定：Key 唯一约束冲突"
	default:
		// 无法区分时，按 Key 占用处理，避免误报 500。
		return CodeKeyBoundToOtherDevice, "并发绑定：唯一约束冲突"
	}
}

type IssueInput struct {
	Count     int
	ExpiresAt *time.Time
	IssuedTo  *string
	Remark    *string
}

type IssuedKey struct {
	ID        int64
	Key       string
	ExpiresAt *time.Time
	IssuedTo  *string
	Remark    *string
}

func (s *Service) IssueKeys(ctx context.Context, in IssueInput) ([]IssuedKey, error) {
	count := in.Count
	if count <= 0 {
		count = 1
	}
	if count > 50 {
		return nil, fmt.Errorf("%w: count 上限 50", errBadRequest)
	}
	now := s.now()
	out := make([]IssuedKey, 0, count)

	err := s.Store.WithTx(ctx, func(tx store.Tx) error {
		for i := 0; i < count; i++ {
			var code string
			var err error
			for attempt := 0; attempt < 5; attempt++ {
				code, err = GenerateKey()
				if err != nil {
					return err
				}
				id, err := tx.InsertKey(ctx, store.LicenseKey{
					KeyCode:   code,
					Status:    StatusActive,
					ExpiresAt: in.ExpiresAt,
					IssuedTo:  in.IssuedTo,
					Remark:    in.Remark,
					CreatedAt: now,
					UpdatedAt: now,
				})
				if err != nil {
					var conflict store.UniqueConflict
					if errors.As(err, &conflict) {
						continue
					}
					return err
				}
				out = append(out, IssuedKey{
					ID:        id,
					Key:       code,
					ExpiresAt: in.ExpiresAt,
					IssuedTo:  in.IssuedTo,
					Remark:    in.Remark,
				})
				break
			}
			if len(out) != i+1 {
				return fmt.Errorf("生成 Key 冲突过多")
			}
		}
		return nil
	})
	return out, err
}

var errBadRequest = errors.New("invalid_request")
var ErrNotFound = errors.New("not_found")

func (s *Service) ListKeys(ctx context.Context, status string) ([]store.KeyListItem, error) {
	var items []store.KeyListItem
	err := s.Store.WithTx(ctx, func(tx store.Tx) error {
		var err error
		items, err = tx.ListKeys(ctx, store.KeyFilter{Status: status}, s.now())
		return err
	})
	return items, err
}

func (s *Service) Unbind(ctx context.Context, keyID int64, reason, actor string) error {
	now := s.now()
	var deleted *store.Binding
	var keyCode string
	err := s.Store.WithTx(ctx, func(tx store.Tx) error {
		lic, err := tx.LockKeyByID(ctx, keyID)
		if err != nil {
			return err
		}
		if lic == nil {
			return ErrNotFound
		}
		keyCode = lic.KeyCode
		deleted, err = tx.DeleteBindingByKeyID(ctx, keyID)
		return err
	})
	if err != nil {
		return err
	}
	fp := ""
	if deleted != nil {
		fp = deleted.DeviceFingerprint
	}
	detail := strings.TrimSpace(reason)
	if detail == "" {
		detail = "管理员解绑"
	}
	if actor != "" {
		detail = detail + "（" + actor + "）"
	}
	// 无绑定则幂等成功，仍可记一条审计便于排查。
	_ = s.Store.InsertAudit(ctx, store.AuditLog{
		KeyID:             keyID,
		KeyCode:           keyCode,
		DeviceFingerprint: fp,
		EventType:         EventUnbind,
		ResultCode:        CodeOK,
		Detail:            detail,
		CreatedAt:         now,
	})
	return nil
}

func (s *Service) Disable(ctx context.Context, keyID int64, reason, actor string) error {
	now := s.now()
	var keyCode, fp string
	err := s.Store.WithTx(ctx, func(tx store.Tx) error {
		lic, err := tx.LockKeyByID(ctx, keyID)
		if err != nil {
			return err
		}
		if lic == nil {
			return ErrNotFound
		}
		keyCode = lic.KeyCode
		lic.Status = StatusDisabled
		lic.UpdatedAt = now
		if err := tx.UpdateKey(ctx, *lic); err != nil {
			return err
		}
		if b, err := tx.GetBindingByKeyID(ctx, keyID); err == nil && b != nil {
			fp = b.DeviceFingerprint
		}
		return nil
	})
	if err != nil {
		return err
	}
	detail := strings.TrimSpace(reason)
	if detail == "" {
		detail = "管理员停用"
	}
	if actor != "" {
		detail = detail + "（" + actor + "）"
	}
	_ = s.Store.InsertAudit(ctx, store.AuditLog{
		KeyID:             keyID,
		KeyCode:           keyCode,
		DeviceFingerprint: fp,
		EventType:         EventValidateFail,
		ResultCode:        CodeInvalid,
		Detail:            detail,
		CreatedAt:         now,
	})
	return nil
}

type PatchInput struct {
	ExpiresAt *time.Time
	ClearExp  bool
	IssuedTo  *string
	Remark    *string
}

func (s *Service) PatchKey(ctx context.Context, keyID int64, in PatchInput) error {
	now := s.now()
	return s.Store.WithTx(ctx, func(tx store.Tx) error {
		lic, err := tx.LockKeyByID(ctx, keyID)
		if err != nil {
			return err
		}
		if lic == nil {
			return ErrNotFound
		}
		if in.ClearExp {
			lic.ExpiresAt = nil
		} else if in.ExpiresAt != nil {
			lic.ExpiresAt = in.ExpiresAt
		}
		if in.IssuedTo != nil {
			lic.IssuedTo = in.IssuedTo
		}
		if in.Remark != nil {
			lic.Remark = in.Remark
		}
		lic.UpdatedAt = now
		return tx.UpdateKey(ctx, *lic)
	})
}
