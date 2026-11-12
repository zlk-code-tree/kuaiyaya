package license

import "net/http"

// 结果码与 docs/data-model.md 第 6 节、docs/key-service-plan.md 第 5.4 节一致。
// 分类不得合并；服务端从不返回「网络不通」这类业务码。
const (
	CodeOK                     = "ok"
	CodeInvalid                = "invalid"
	CodeExpired                = "expired"
	CodeDeviceBoundToOtherKey  = "device_bound_to_other_key"
	CodeKeyBoundToOtherDevice  = "key_bound_to_other_device"
	CodeNotBound               = "not_bound"
	CodeInvalidRequest         = "invalid_request"
	CodeAdminUnauthorized      = "admin_unauthorized"
)

const (
	EventBind         = "bind"
	EventUnbind       = "unbind"
	EventValidateOK   = "validate_ok"
	EventValidateFail = "validate_fail"
)

const (
	StatusActive   uint8 = 1
	StatusDisabled uint8 = 2
)

const DeviceIDPattern = `^[0-9a-f]{64}$`

type Mode string

const (
	ModeActivate Mode = "activate"
	ModeSilent   Mode = "silent"
)

// HTTPStatus 返回业务码对应的 HTTP 状态。成功由调用方直接写 200。
func HTTPStatus(code string) int {
	switch code {
	case CodeOK:
		return http.StatusOK
	case CodeInvalidRequest:
		return http.StatusBadRequest
	case CodeInvalid, CodeExpired:
		return http.StatusForbidden
	case CodeDeviceBoundToOtherKey, CodeKeyBoundToOtherDevice, CodeNotBound:
		return http.StatusConflict
	case CodeAdminUnauthorized:
		return http.StatusUnauthorized
	default:
		return http.StatusInternalServerError
	}
}

// DevMessage 是给日志/开发看的说明，不是用户可见文案。
func DevMessage(code string) string {
	switch code {
	case CodeInvalid:
		return "key does not exist or is disabled"
	case CodeExpired:
		return "key has expired"
	case CodeDeviceBoundToOtherKey:
		return "this device is already bound to another key"
	case CodeKeyBoundToOtherDevice:
		return "this key is already bound to another device"
	case CodeNotBound:
		return "key and device are both unbound; silent validate does not bind"
	case CodeInvalidRequest:
		return "invalid request"
	case CodeAdminUnauthorized:
		return "admin unauthorized"
	default:
		return code
	}
}
