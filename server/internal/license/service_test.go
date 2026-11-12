package license

import (
	"context"
	"strings"
	"sync"
	"testing"
	"time"

	"kuaiyaya/server/internal/store"
)

const (
	devA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	devB = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
	devC = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
)

func setup(t *testing.T, now time.Time) (*Service, *store.Memory) {
	t.Helper()
	mem := store.NewMemory()
	svc := NewService(mem)
	svc.Now = func() time.Time { return now }
	return svc, mem
}

func issue(t *testing.T, svc *Service, expires *time.Time, issuedTo string) IssuedKey {
	t.Helper()
	var to *string
	if issuedTo != "" {
		to = &issuedTo
	}
	out, err := svc.IssueKeys(context.Background(), IssueInput{Count: 1, ExpiresAt: expires, IssuedTo: to})
	if err != nil {
		t.Fatalf("issue: %v", err)
	}
	if len(out) != 1 {
		t.Fatalf("expected 1 key, got %d", len(out))
	}
	if !strings.HasPrefix(out[0].Key, "KYDY-") || len(out[0].Key) != 19 {
		t.Fatalf("unexpected key format: %s", out[0].Key)
	}
	return out[0]
}

func check(t *testing.T, svc *Service, key, device string, mode Mode) CheckResult {
	t.Helper()
	res, err := svc.Check(context.Background(), CheckInput{Key: key, DeviceID: device, Mode: mode})
	if err != nil {
		t.Fatalf("check: %v", err)
	}
	return res
}

func TestActivateThenValidate(t *testing.T) {
	now := time.Date(2026, 11, 12, 4, 0, 0, 0, time.UTC)
	svc, _ := setup(t, now)
	k := issue(t, svc, nil, "张三")

	act := check(t, svc, k.Key, devA, ModeActivate)
	if act.Code != CodeOK {
		t.Fatalf("activate want ok, got %s", act.Code)
	}
	if act.ExpiresAt != nil {
		t.Fatalf("nil expiry expected")
	}
	val := check(t, svc, k.Key, devA, ModeSilent)
	if val.Code != CodeOK {
		t.Fatalf("validate want ok, got %s", val.Code)
	}
}

func TestSilentDoesNotBind(t *testing.T) {
	now := time.Date(2026, 11, 12, 4, 0, 0, 0, time.UTC)
	svc, _ := setup(t, now)
	k := issue(t, svc, nil, "")
	res := check(t, svc, k.Key, devA, ModeSilent)
	if res.Code != CodeNotBound {
		t.Fatalf("want not_bound, got %s", res.Code)
	}
	// 随后 activate 仍应能绑定
	act := check(t, svc, k.Key, devA, ModeActivate)
	if act.Code != CodeOK {
		t.Fatalf("activate after silent want ok, got %s", act.Code)
	}
}

func TestInvalidAndDisabled(t *testing.T) {
	now := time.Date(2026, 11, 12, 4, 0, 0, 0, time.UTC)
	svc, _ := setup(t, now)
	res := check(t, svc, "KYDY-ZZZZ-ZZZZ-ZZZZ", devA, ModeActivate)
	if res.Code != CodeInvalid {
		t.Fatalf("missing key want invalid, got %s", res.Code)
	}
	k := issue(t, svc, nil, "")
	if err := svc.Disable(context.Background(), k.ID, "误发", "admin"); err != nil {
		t.Fatal(err)
	}
	res = check(t, svc, k.Key, devA, ModeActivate)
	if res.Code != CodeInvalid {
		t.Fatalf("disabled want invalid, got %s", res.Code)
	}
}

func TestExpiredKeepsBindingAndBlocksNewBind(t *testing.T) {
	now := time.Date(2026, 11, 12, 4, 0, 0, 0, time.UTC)
	exp := now.Add(time.Hour)
	svc, mem := setup(t, now)
	k := issue(t, svc, &exp, "")
	if check(t, svc, k.Key, devA, ModeActivate).Code != CodeOK {
		t.Fatal("activate should succeed before expiry")
	}

	later := now.Add(2 * time.Hour)
	svc.Now = func() time.Time { return later }
	res := check(t, svc, k.Key, devA, ModeSilent)
	if res.Code != CodeExpired {
		t.Fatalf("want expired, got %s", res.Code)
	}

	// 绑定行应仍在
	var stillBound bool
	_ = mem.WithTx(context.Background(), func(tx store.Tx) error {
		b, err := tx.GetBindingByFingerprint(context.Background(), devA)
		stillBound = err == nil && b != nil
		return err
	})
	if !stillBound {
		t.Fatal("expired key must keep the binding")
	}

	// 未绑定的过期 Key 不能完成首次绑定
	exp2 := now.Add(time.Hour)
	svc.Now = func() time.Time { return now }
	k2 := issue(t, svc, &exp2, "")
	svc.Now = func() time.Time { return later }
	res = check(t, svc, k2.Key, devB, ModeActivate)
	if res.Code != CodeExpired {
		t.Fatalf("unbound expired activate want expired, got %s", res.Code)
	}
	var bound bool
	_ = mem.WithTx(context.Background(), func(tx store.Tx) error {
		b, err := tx.GetBindingByKeyID(context.Background(), k2.ID)
		bound = err == nil && b != nil
		return nil
	})
	if bound {
		t.Fatal("expired activate must not insert a binding")
	}

	// 延长有效期后，原绑定 validate 通过
	newExp := later.Add(24 * time.Hour)
	if err := svc.PatchKey(context.Background(), k.ID, PatchInput{ExpiresAt: &newExp}); err != nil {
		t.Fatal(err)
	}
	res = check(t, svc, k.Key, devA, ModeSilent)
	if res.Code != CodeOK {
		t.Fatalf("after extend want ok, got %s", res.Code)
	}
}

func TestDeviceBoundToOtherKeyHasPriority(t *testing.T) {
	now := time.Date(2026, 11, 12, 4, 0, 0, 0, time.UTC)
	svc, _ := setup(t, now)
	kA := issue(t, svc, nil, "")
	if check(t, svc, kA.Key, devA, ModeActivate).Code != CodeOK {
		t.Fatal("bind A")
	}

	kB := issue(t, svc, nil, "")
	res := check(t, svc, kB.Key, devA, ModeActivate)
	if res.Code != CodeDeviceBoundToOtherKey {
		t.Fatalf("valid other key want device_bound_to_other_key, got %s", res.Code)
	}

	// 即便另一枚无效
	res = check(t, svc, "KYDY-NOPE-NOPE-NOPE", devA, ModeActivate)
	if res.Code != CodeDeviceBoundToOtherKey {
		t.Fatalf("invalid other key still device_bound_to_other_key, got %s", res.Code)
	}

	// 即便另一枚过期
	exp := now.Add(-time.Minute)
	kOld := issue(t, svc, &exp, "")
	res = check(t, svc, kOld.Key, devA, ModeActivate)
	if res.Code != CodeDeviceBoundToOtherKey {
		t.Fatalf("expired other key still device_bound_to_other_key, got %s", res.Code)
	}

	// 静默校验换 Key 同样优先
	res = check(t, svc, kB.Key, devA, ModeSilent)
	if res.Code != CodeDeviceBoundToOtherKey {
		t.Fatalf("silent other key want device_bound_to_other_key, got %s", res.Code)
	}
}

func TestKeyBoundToOtherDevice(t *testing.T) {
	now := time.Date(2026, 11, 12, 4, 0, 0, 0, time.UTC)
	svc, _ := setup(t, now)
	k := issue(t, svc, nil, "")
	if check(t, svc, k.Key, devA, ModeActivate).Code != CodeOK {
		t.Fatal("bind A")
	}
	res := check(t, svc, k.Key, devB, ModeActivate)
	if res.Code != CodeKeyBoundToOtherDevice {
		t.Fatalf("want key_bound_to_other_device, got %s", res.Code)
	}
	res = check(t, svc, k.Key, devB, ModeSilent)
	if res.Code != CodeKeyBoundToOtherDevice {
		t.Fatalf("silent want key_bound_to_other_device, got %s", res.Code)
	}
}

func TestUnbindThenSilentNotBoundAndReactivate(t *testing.T) {
	now := time.Date(2026, 11, 12, 4, 0, 0, 0, time.UTC)
	svc, _ := setup(t, now)
	k := issue(t, svc, nil, "")
	if check(t, svc, k.Key, devA, ModeActivate).Code != CodeOK {
		t.Fatal("bind")
	}
	if err := svc.Unbind(context.Background(), k.ID, "换机", "admin"); err != nil {
		t.Fatal(err)
	}
	res := check(t, svc, k.Key, devA, ModeSilent)
	if res.Code != CodeNotBound {
		t.Fatalf("after unbind silent want not_bound, got %s", res.Code)
	}
	// 不解绑则不能被新设备抢走：已解绑，新设备可 activate
	res = check(t, svc, k.Key, devB, ModeActivate)
	if res.Code != CodeOK {
		t.Fatalf("new device activate after unbind want ok, got %s", res.Code)
	}
	// 旧设备再次 validate 因 Key 已被新设备占用
	res = check(t, svc, k.Key, devA, ModeSilent)
	if res.Code != CodeKeyBoundToOtherDevice {
		t.Fatalf("old device after new bind want key_bound_to_other_device, got %s", res.Code)
	}
}

func TestUnbindAllowsOriginalDeviceReactivateIfStillFree(t *testing.T) {
	now := time.Date(2026, 11, 12, 4, 0, 0, 0, time.UTC)
	svc, _ := setup(t, now)
	k := issue(t, svc, nil, "")
	if check(t, svc, k.Key, devA, ModeActivate).Code != CodeOK {
		t.Fatal("bind")
	}
	if err := svc.Unbind(context.Background(), k.ID, "换机", "admin"); err != nil {
		t.Fatal(err)
	}
	res := check(t, svc, k.Key, devA, ModeActivate)
	if res.Code != CodeOK {
		t.Fatalf("original device re-activate want ok, got %s", res.Code)
	}
}

func TestUnbindIdempotent(t *testing.T) {
	now := time.Date(2026, 11, 12, 4, 0, 0, 0, time.UTC)
	svc, _ := setup(t, now)
	k := issue(t, svc, nil, "")
	if err := svc.Unbind(context.Background(), k.ID, "", "admin"); err != nil {
		t.Fatal(err)
	}
	if err := svc.Unbind(context.Background(), k.ID, "", "admin"); err != nil {
		t.Fatal(err)
	}
}

func TestReinstallFingerprint(t *testing.T) {
	now := time.Date(2026, 11, 12, 4, 0, 0, 0, time.UTC)
	svc, _ := setup(t, now)
	k := issue(t, svc, nil, "")
	if check(t, svc, k.Key, devA, ModeActivate).Code != CodeOK {
		t.Fatal("bind old fingerprint")
	}
	// 安装 ID 变化 → 新指纹。validate 失败，Key 仍被旧指纹占用。
	res := check(t, svc, k.Key, devC, ModeSilent)
	if res.Code != CodeKeyBoundToOtherDevice {
		t.Fatalf("new fp silent want key_bound_to_other_device, got %s", res.Code)
	}
	res = check(t, svc, k.Key, devC, ModeActivate)
	if res.Code != CodeKeyBoundToOtherDevice {
		t.Fatalf("new fp activate without unbind want key_bound_to_other_device, got %s", res.Code)
	}
	if err := svc.Unbind(context.Background(), k.ID, "重装", "admin"); err != nil {
		t.Fatal(err)
	}
	res = check(t, svc, k.Key, devC, ModeActivate)
	if res.Code != CodeOK {
		t.Fatalf("after unbind new fp want ok, got %s", res.Code)
	}
}

func TestNormalizeKeyAndInvalidRequest(t *testing.T) {
	now := time.Date(2026, 11, 12, 4, 0, 0, 0, time.UTC)
	svc, _ := setup(t, now)
	k := issue(t, svc, nil, "")
	spaced := "  " + strings.ToLower(k.Key) + "  "
	res := check(t, svc, spaced, devA, ModeActivate)
	if res.Code != CodeOK {
		t.Fatalf("normalized key want ok, got %s", res.Code)
	}
	res, err := svc.Check(context.Background(), CheckInput{Key: k.Key, DeviceID: "not-a-hash", Mode: ModeActivate})
	if err != nil {
		t.Fatal(err)
	}
	if res.Code != CodeInvalidRequest {
		t.Fatalf("bad deviceId want invalid_request, got %s", res.Code)
	}
	res, err = svc.Check(context.Background(), CheckInput{Key: "", DeviceID: devA, Mode: ModeActivate})
	if err != nil {
		t.Fatal(err)
	}
	if res.Code != CodeInvalidRequest {
		t.Fatalf("empty key want invalid_request, got %s", res.Code)
	}
}

func TestRepeatActivateDoesNotDuplicate(t *testing.T) {
	now := time.Date(2026, 11, 12, 4, 0, 0, 0, time.UTC)
	svc, mem := setup(t, now)
	k := issue(t, svc, nil, "")
	if check(t, svc, k.Key, devA, ModeActivate).Code != CodeOK {
		t.Fatal()
	}
	if check(t, svc, k.Key, devA, ModeActivate).Code != CodeOK {
		t.Fatal("repeat activate should be ok")
	}
	var n int
	_ = mem.WithTx(context.Background(), func(tx store.Tx) error {
		items, err := tx.ListKeys(context.Background(), store.KeyFilter{}, now)
		n = 0
		for _, it := range items {
			if it.BoundAt != nil {
				n++
			}
		}
		return err
	})
	if n != 1 {
		t.Fatalf("want 1 binding, got %d", n)
	}
}

func TestConcurrentActivateSameKey(t *testing.T) {
	now := time.Date(2026, 11, 12, 4, 0, 0, 0, time.UTC)
	svc, mem := setup(t, now)
	k := issue(t, svc, nil, "")

	// 内存库用互斥锁串行事务，仍可验证只有一个成功。
	var wg sync.WaitGroup
	codes := make(chan string, 2)
	for _, d := range []string{devA, devB} {
		wg.Add(1)
		device := d
		go func() {
			defer wg.Done()
			res, err := svc.Check(context.Background(), CheckInput{Key: k.Key, DeviceID: device, Mode: ModeActivate})
			if err != nil {
				codes <- "err:" + err.Error()
				return
			}
			codes <- res.Code
		}()
	}
	wg.Wait()
	close(codes)
	got := map[string]int{}
	for c := range codes {
		got[c]++
	}
	if got[CodeOK] != 1 {
		t.Fatalf("exactly one ok expected, got %v", got)
	}
	if got[CodeKeyBoundToOtherDevice] != 1 && got[CodeDeviceBoundToOtherKey] != 1 {
		// 后到的应是 key_bound_to_other_device（同一把 Key）
		t.Fatalf("the other must be a conflict business code, got %v", got)
	}
	var binds int
	_ = mem.WithTx(context.Background(), func(tx store.Tx) error {
		items, err := tx.ListKeys(context.Background(), store.KeyFilter{Status: "bound"}, now)
		binds = len(items)
		return err
	})
	if binds != 1 {
		t.Fatalf("want 1 binding after concurrent activate, got %d", binds)
	}
}

func TestTranslateUniqueConflict(t *testing.T) {
	code, _ := translateConflict(store.UniqueConflict{Index: "uk_key_id"})
	if code != CodeKeyBoundToOtherDevice {
		t.Fatalf("uk_key_id → key_bound_to_other_device, got %s", code)
	}
	code, _ = translateConflict(store.UniqueConflict{Index: "uk_device_fingerprint"})
	if code != CodeDeviceBoundToOtherKey {
		t.Fatalf("uk_device_fingerprint → device_bound_to_other_key, got %s", code)
	}
}

func TestArrivalIsExpired(t *testing.T) {
	// now >= expires_at 即过期（到达即失效）
	now := time.Date(2026, 11, 12, 4, 0, 0, 0, time.UTC)
	svc, _ := setup(t, now)
	exp := now // 正好到达
	k := issue(t, svc, &exp, "")
	res := check(t, svc, k.Key, devA, ModeActivate)
	if res.Code != CodeExpired {
		t.Fatalf("now == expires_at want expired, got %s", res.Code)
	}
}

func TestHTTPStatusMapping(t *testing.T) {
	if HTTPStatus(CodeInvalid) != 403 || HTTPStatus(CodeExpired) != 403 {
		t.Fatal("invalid/expired should be 403")
	}
	if HTTPStatus(CodeDeviceBoundToOtherKey) != 409 || HTTPStatus(CodeNotBound) != 409 {
		t.Fatal("conflicts should be 409")
	}
	if HTTPStatus(CodeInvalidRequest) != 400 {
		t.Fatal("invalid_request should be 400")
	}
}

func TestGenerateKeyCharset(t *testing.T) {
	for i := 0; i < 20; i++ {
		k, err := GenerateKey()
		if err != nil {
			t.Fatal(err)
		}
		n := NormalizeKey(k)
		if n != k {
			t.Fatalf("generated key should already be normalized: %s", k)
		}
		for _, r := range strings.ReplaceAll(k[5:], "-", "") {
			if !strings.ContainsRune(crockford, r) {
				t.Fatalf("char %c not in Crockford set: %s", r, k)
			}
			if strings.ContainsRune("ILOU", r) {
				t.Fatalf("forbidden char %c in %s", r, k)
			}
		}
	}
}
