/** 用户可见文案，按 key-service-plan 第 5.4 节与原型，不直接展示服务端 message。 */

export const MSG = {
  network:
    "网络不通，暂时连不上服务端。请检查网络后再试。",
  networkStart:
    "网络不通，无法校验 Key，暂时不能开始压缩。请连网后再试。这不是 Key 无效或过期，也不是编码失败。",
  networkBanner:
    "当前网络不通，无法校验 Key，暂时不能开始压缩。你仍可查看或打开已有文件。",
  invalidOrExpired:
    "Key 无效或已过期。请确认 Key 后重试，或更换有效 Key。",
  invalidOrExpiredStart:
    "当前 Key 无效或已过期，不能开始压缩。你仍可查看或打开已有文件。重新输入有效 Key 后即可继续压缩。",
  expiredBanner:
    "当前 Key 已过期，不能开始压缩。你仍可查看或打开已有文件。",
  deviceBoundToOtherKey:
    "本机已匹配其他 Key。如需更换，请联系管理员先解绑当前绑定。",
  keyBoundToOtherDevice:
    "该 Key 已绑定其他电脑。如需换机使用，请联系管理员先解绑。",
  notBound:
    "当前绑定已解除或设备身份已变化，不能开始压缩。请联系管理员，或重新输入 Key。",
  notBoundBanner:
    "当前绑定已解除或设备身份已变化，不能开始压缩。请联系管理员，或重新输入 Key。你仍可查看或打开已有文件。",
  invalidRequest: "请求无效，请稍后重试。",
  emptyKey: "请输入 Key。",
  activated: "已开通，可以开始压缩。",
  targetTooLarge: "原片已经不大于目标大小，无需压缩。请调低目标后再开始。",
  diskLowPrefix: "开始压缩需要约 ",
  diskLowSuffix: " 的可用空间（含余量）。请清理磁盘后再试。",
  noWrite: "没有权限在原片所在目录写入输出文件。请检查文件夹权限后再试。",
  unsupported: "不支持此文件，请选择视频。",
  cancelled: "已取消。未完成的临时文件已清理，原片没有改动。",
  encodeFail: "编码未能完成。原片没有被修改，临时文件已清理。",
  missingOutput: "文件已不在原位置。",
  closeWhileWorkTitle: "确定取消压缩？",
  closeWhileWork:
    "压缩还没完成。未完成的临时文件会被清理，原片不会改动。再次开始会从头编码。",
  queueSkipped: "原片已经不大于上限，已跳过。",
  notSmaller: "压缩后体积未小于原片，未保存结果；原片没有改动。",
  missedCap: "未能压到目标体积，未保存结果；原片没有改动。",
  queueUnreadable: "无法读取该视频。原片没有改动。",
  queueCloseTitle: "确定取消全部？",
  queueCloseDetail:
    "队列还没完成。确定后将停止当前压缩，未开始的标为已取消，并清理临时文件。原片不会改动，也不会留下半成品。",
} as const;

export const MAINTAINER = "黑曼巴的紫金王朝";
export const FEEDBACK_EMAIL = "zhanglikunmamba@gmail.com";
export const APP_NAME = "快鸭鸭";
export const KEYCHAIN_SERVICE = "cn.kuaiyaya.desktop";
export const FINGERPRINT_SALT = "kuaiyaya.v1";
export const API_TIMEOUT_MS = 8_000;
