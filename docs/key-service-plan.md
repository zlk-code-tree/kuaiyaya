# 快鸭鸭第一期 · Key 校验服务技术方案（服务端）

| 项 | 内容 |
| --- | --- |
| 文档版本 | 0.2（待审） |
| 日期 | 2026-11-12（Asia/Shanghai） |
| 作者 | go资深高级开发专家（主笔） |
| 状态 | 技术方案，先不写代码；与库表基线对齐后，请昆哥小弟一并转昆哥拍板 |
| 技术栈 | Go + Gin；库按 MySQL 8（已定） |
| 关联文档 | [产品方案 1.0](/workspace/plans/video-compressor-product/product-plan.md) 第 5.1.2、7.2 节；[数据模型](/workspace/plans/video-compressor-tech/data-model.md)（服务端方案基线）；[客户端方案](/workspace/plans/video-compressor-tech/tech-plan.md) 第 8 节（对接契约） |

---

## 1. 结论

第一期做一套**只负责门禁**的轻量 Key 服务（Go + Gin），不接收、不存储视频。压缩仍在本机完成；客户端只为校验 Key 合法性、有效期和一对一绑定访问本服务。

库表以 `data-model.md` 为基线，不再另起一套：**三张表**（`license_keys`、`device_bindings`、`binding_audit_logs`），MySQL 8，一对一用唯一约束兜底，过期用 `expires_at` 现算、不自动解绑。

客户端提供两个接口，对应数据模型里的两种 mode：

- `POST /v1/license/activate`：用户显式输入 Key（`activate`）。满足条件则绑定。
- `POST /v1/license/validate`：已绑定后的静默校验，以及点「开始压缩」时的等待校验（`silent`）。**绝不自动绑定**，避免解绑后旧电脑把 Key 抢回去。

结果码与数据模型第 6 节对齐，**分类不合并**：`ok`、`invalid`、`expired`、`device_bound_to_other_key`、`key_bound_to_other_device`、`not_bound`。`invalid` 与 `expired` 接口必须分开，客户端对用户可以都归到「Key 无效或过期」。连不上服务端、超时、TLS 失败、5xx 由客户端归为「网络不通」，服务端业务码从不表达这一类。

设备指纹按昆哥小弟已拍的方向：**`SHA-256(kuaiyaya.v1 + 硬件 UUID + 本机安装 ID)`**，64 位小写 hex。服务端只收哈希并做全等比对，不收原始硬件序列号。只用钥匙串 UUID 会在「把钥匙串拷到另一台电脑」时被占用，故不采用。盐值/产品标识统一写成 `kuaiyaya.v1`，不要写成 `kuayaya`。请 @资深DB @node.js高级专家 把数据模型和客户端第 8.1 节改回这一套。

管理侧用独立 `/v1/admin/*` + 管理 Token 签发、解绑、停用、改有效期，不做终端用户账号。

---

## 2. 范围与非目标

**做**

- 管理员创建并分发 Key，可设或延长有效期，可停用、可解绑。
- 客户端首次输入 Key 后联网激活；成功即绑定。
- 已绑定客户端每次打开后必须再向服务端静默校验；不得把上次成功当作离线通行证。
- 一对一绑定；换机、重装须管理员解绑后才能用原 Key 重新激活。
- 过期只拦压缩（服务端返回 `expired`，不删绑定）；解绑后旧设备 `validate` 返回 `not_bound`，不能压缩。

**不做**

- 用户注册、登录、找回、个人中心。
- 接收或中转视频，或任何压缩任务接口。
- 对外销售、支付、自助购买。
- 自动解绑、按过期自动解绑、因换机强制换发新 Key。
- 把历史校验成功当作离线通行证。
- 完整管理后台页面（第一期管理 API + 脚本即可）。
- 高可用集群、Redis、读写分离。

---

## 3. 与已审基线对齐的要点

1. **激活才会绑定，静默校验不绑定。** 管理员解绑 = 删除 `device_bindings` 当前行并写审计。旧设备下一次 `validate` 走 `not_bound`，不能压缩，也不会自动抢回 Key。用户在开通页再次显式 `activate` 才可能重绑（若该 Key 仍空闲）。这是已审基线，本方案采用，第一期不做「解绑后阻止原设备再激活」的额外表。
2. **过期与解绑是两件事。** 过期不改 `status`、不删绑定；本机要换另一枚 Key，仍须先解绑。延长 `expires_at` 后，原绑定下次校验即可通过。
3. **停用（`status=2`）视为 `invalid`，不是 `expired`。** 建议停用与解绑分成两个管理操作；若要让该设备改绑其它 Key，须再解绑。
4. **判定顺序（激活）。** 若本机指纹已绑定**其他** Key，无论新输入的 Key 是否存在、停用或过期，都优先返回 `device_bound_to_other_key`。
5. **明文存 Key。** 按数据模型：内部试用允许 `key_code` 明文入库，便于管理员查看和重发同一枚原 Key。访问与备份按敏感配置看管。服务端日志仍不得打印 Key 原文。

---

## 4. 总体架构

```
管理员（内部） --HTTPS + Admin Token-->  Gin /v1/admin/*   -->  MySQL 8
快鸭鸭客户端   --HTTPS---------------->  Gin /v1/license/* -->  同上（无会话，绑定落库）
```

- 单进程，配置走环境变量。
- 应用前用 Nginx / Caddy 或云负载均衡终止 TLS。
- 内部小范围试用、打开应用时校验一次，单实例足够。

建议模块：`cmd/keyserver`，`internal/http`（路由、限流、管理鉴权、日志脱敏），`internal/license`（激活 / 校验 / 解绑领域逻辑），`internal/store`，`internal/config`。

---

## 5. API 约定

- JSON、UTF-8。时间 **RFC3339、UTC**（管理展示可转 Asia/Shanghai）。
- 成功：HTTP 200，`{"ok": true, "data": {...}}`。
- 业务失败：见下表 HTTP，`{"ok": false, "error": {"code": "<结果码>", "message": "<供日志/开发>"}}`。用户可见文案由客户端按 `code` 映射，避免服务端改措辞把分类弄乱。
- 成功响应带 `serverTime`；激活 / 校验成功时带 `expiresAt`（无期限为 `null`）。
- Key 只放请求体，不放 URL / query。
- 日志只记 `key_id`、`key_code` 前缀、结果码、设备指纹哈希，禁止记 Key 原文。
- 字段名与客户端草案对齐，用 camelCase；入库映射到 `data-model.md` 的蛇形列名。

### 5.1 判定顺序（必须按此实现）

对规范化后的 Key（去空白、统一大写）和 `deviceId`，在同一事务内读改，并对 `license_keys` 行加锁；唯一约束冲突要翻译成业务码，不能变成 500。

**`activate`（`POST /v1/license/activate`）**

1. 本指纹已绑定**其他** Key → `device_bound_to_other_key`（即便本次输入的 Key 无效或过期，也先返回这个）。
2. Key 不存在，或 `status=停用` → `invalid`。
3. Key 已过期（`expires_at` 非空且 `now >= expires_at`）→ `expired`。已绑本设备则保留绑定、不更新 `last_seen_at`；未绑则不插入。
4. 本 Key 已绑定**其他**指纹 → `key_bound_to_other_device`。
5. 已绑定本设备且未过期 → 更新 `last_seen_at`，返回 `ok`（重复激活，不新建行）。
6. 本 Key、本指纹当前都无绑定，且 Key 启用未过期 → 插入绑定，返回 `ok`。这就是「第一次成功校验即绑定」。

**`validate` / `silent`（`POST /v1/license/validate`）**

前 4 步与上面相同（本机已绑其他 Key 同样优先）。第 5 步同样返回 `ok` 并更新 `last_seen_at`。到「两边都无绑定」时：**不插入绑定**，返回 `not_bound`（刚被解绑的旧电脑走这里）。

`not_bound` 归入 Key / 绑定问题，客户端不能当成网络不通；可引导重新输入 Key。仍只拦压缩，可打开应用和已有文件。

### 5.2 客户端：激活

`POST /v1/license/activate`

```json
{
  "key": "KYDY-XXXX-XXXX-XXXX",
  "deviceId": "<64 位小写 hex，见第 6 节>",
  "appVersion": "1.0.0",
  "platform": "darwin",
  "arch": "arm64",
  "deviceLabel": "张三的 MacBook Pro"
}
```

`deviceLabel` 可选，只进 `device_label` 供管理查看（主机名、系统版本等），禁止传明文硬件序列号。`platform` / `arch` / `appVersion` 建议一并写入 `device_label` 或仅打日志，不参与匹配。

成功 `data`：

```json
{
  "expiresAt": "2027-01-01T15:59:59.000Z",
  "serverTime": "2026-11-12T03:41:00.000Z"
}
```

### 5.3 客户端：校验（静默，不绑定）

`POST /v1/license/validate`

```json
{
  "key": "KYDY-XXXX-XXXX-XXXX",
  "deviceId": "<与激活时相同>",
  "appVersion": "1.0.0"
}
```

必须带 Key 和 `deviceId`。不接受「不带 Key、或把校验当绑定」。

成功 `data` 同激活：`expiresAt`、`serverTime`。

### 5.4 结果码与 HTTP、客户端归类

| error.code | HTTP | 客户端归类 | 说明 |
| --- | --- | --- | --- |
| （成功，无 error） | 200 | 通过，可压缩 | 对应结果码 `ok` |
| `invalid` | 403 | Key 无效或过期 | 不存在或已停用 |
| `expired` | 403 | Key 无效或过期；已绑定过期可用原型过期横幅 | 存在但已过期 |
| `device_bound_to_other_key` | 409 | 本机已匹配其他 Key。如需更换，请联系管理员先解绑当前绑定。 | 含「再输入一枚无效/过期 Key」 |
| `key_bound_to_other_device` | 409 | 该 Key 已绑定其他电脑。如需换机使用，请联系管理员先解绑。 | 单独文案，避免用户以为 Key 打错 |
| `not_bound` | 409 | 当前绑定已解除或设备身份已变化，不能开始压缩。请联系管理员，或重新输入 Key。 | 仅静默校验；不说成网络不通 |
| `invalid_request` | 400 | 可提示重试；不要说成 Key 无效或网络不通 | 缺字段、`deviceId` 格式不对 |
| （无业务码） | 超时 / 连接失败 / TLS / 5xx / 429 | **网络不通**，暂时连不上服务端 | 服务端从不返回一个叫「网络不通」的业务码 |

客户端本地已有绑定时，若用户再输入另一枚，可先在本地拒绝；**服务端仍必须按第 5.1 节再判一次**，不能只靠客户端。

建议客户端超时 8 秒（与客户端方案一致）；限流建议：激活每 IP 每分钟 10 次，校验每分钟 30 次，超限 429，归入网络不通，可稍后重试。

### 5.5 健康检查

- `GET /healthz`：进程存活。
- `GET /readyz`：能连上数据库才 200。不必鉴权，不暴露内部细节。

### 5.6 管理 API

均需 `Authorization: Bearer <ADMIN_API_TOKEN>`。未带或错误 → HTTP 401，`admin_unauthorized`。写操作记 `binding_audit_logs`（及必要时的变更时间）。管理员身份用请求里的 `actor` 文本 + 令牌即可，第一期不建管理员账号表。

**创建 Key** `POST /v1/admin/keys`

```json
{
  "count": 1,
  "expiresAt": "2027-01-01T15:59:59.000Z",
  "issuedTo": "张三",
  "remark": "内部试用",
  "actor": "admin"
}
```

- `count` 默认 1，第一期上限 50。
- `expiresAt` 可空（与表定义一致，`null` 表示无期限）。建议内部试用都带期限，但不在接口上强制。
- 服务端生成 Key 原文并入库（明文，见基线），响应返回 `id`、`key`、`expiresAt`、`issuedTo`、`remark`。

Key 形态：`KYDY-XXXX-XXXX-XXXX`，`X` 取 Crockford Base32（去掉 I、L、O、U），12 个有效字符。入库前规范化。原型演示短码不是正式格式，不必兼容。

**列出 Key** `GET /v1/admin/keys?status=active|expired|disabled|bound|unbound`

返回 `id`、`key`（内部试用按数据模型可回显以便重发）、`status`、`expiresAt`、`issuedTo`、`remark`、绑定的 `deviceLabel`、`boundAt`、`lastSeenAt`。此接口仅管理令牌可访问。

**解绑** `POST /v1/admin/keys/{id}/unbind`

```json
{ "reason": "换机", "actor": "admin" }
```

无绑定则幂等成功。删除当前绑定行，写 `unbind` 审计。不改 Key、不强制换发。原 Key 可立即被新设备 `activate`，或由原设备再次显式激活。

**停用** `POST /v1/admin/keys/{id}/disable`

```json
{ "reason": "误发或不再使用", "actor": "admin" }
```

`status=2`。不自动解绑；该 Key 校验一律 `invalid`。要让设备改绑其它 Key，再调解绑。

**改有效期 / 备注** `PATCH /v1/admin/keys/{id}`

```json
{ "expiresAt": "2027-06-01T15:59:59.000Z", "issuedTo": "张三", "remark": "续期", "actor": "admin" }
```

不能改 `key_code`，不能用本接口解绑。把过期时间推后后，已绑定设备下次 `validate` 即可通过。

---

## 6. 设备指纹

服务端不采集、不存储原始硬件序列号，只接收客户端按下列算法算好的哈希，写入 `device_bindings.device_fingerprint`，按字符串全等匹配。

**v1 算法（macOS 第一期，客户端计算）：**

```
deviceId = SHA-256(
  "kuaiyaya.v1" + "|" + hw_uuid + "|" + os_install_id
) 的小写 hex（64 字符）
```

| 分量 | macOS 取值 | 作用 |
| --- | --- | --- |
| 盐值 / 标识 | 固定字符串 `kuaiyaya.v1`（不要写成 `kuayaya`） | 避免裸哈希与其它系统撞车 |
| `hw_uuid` | `IOPlatformUUID` | 挡住「把钥匙串或安装目录拷到另一台电脑仍占用绑定」 |
| `os_install_id` | 系统卷 Volume UUID | 重装系统、换硬盘、迁移导致安装标识变化时，指纹改变，须管理员解绑后重绑原 Key |

应用更新、正常重启：两个分量都不变，指纹不变，不必解绑。  
不要用 MAC 地址、主机名参与哈希。主机名等只放可选的 `deviceLabel`。

服务端校验：`deviceId` 必须是 64 位小写 hex，否则 `invalid_request`。服务端不再加盐、不重算。

`device_fingerprint` 列当前注释仍写「钥匙串 UUID」，请数据模型第 4 节及 DDL 注释改回本算法；列类型 `VARCHAR(64)` 已够用，不必改表结构。

客户端仍可以把算好的 `deviceId` 放进钥匙串，以免每次启动重复计算；**不能把自行生成的随机 UUID 当作绑定 ID**。指纹算法变更必须升版本并做迁移，不能让已绑定设备在升级后全部变成新设备。第一期只定义 v1。

后续若做 Windows / Linux，保持同一公式，再约定各平台的 `hw_uuid` 与 `os_install_id` 取值。

---

## 7. 解绑、换机、重装（服务端行为）

- **换机：** 管理员解绑 → 旧电脑下次 `validate` 得 `not_bound`，立刻不能压缩，仍可打开应用和已有文件 → 新电脑输入原 Key 做 `activate` 成功。不必换发。注意：解绑后到新电脑激活前，若旧电脑用户再次显式输入原 Key，按基线可以绑回去；换机操作上应解绑后尽快在新机激活。
- **重装（指纹因安装 ID 变化而改变）：** 旧指纹仍占用该 Key，`validate` 因指纹对不上走到 `not_bound` 或 `key_bound_to_other_device`（本 Key 仍绑着旧指纹）。须管理员解绑后，在本机用原 Key `activate`。不强制换发。
- **本机换另一枚 Key：** 只要本指纹仍绑定 Key A，激活 Key B 一律 `device_bound_to_other_key`（含 B 无效或过期）。须先解绑 A。

---

## 8. 与客户端无感校验的协作（产品方案第 5.1.2 节）

本服务不实现 UI。客户端须遵守：

1. 无本地绑定：只显示开通页，调 `activate`。此步无法无感。
2. 已绑定后启动：直接进主界面，后台调 `validate`，不弹开通页、不打断操作。
3. 「本次已通过」只存在内存，且必须是**这次进程里** `validate` 成功。关闭即丢弃。磁盘不得写上次成功用来跳过联网的字段。
4. 点「开始压缩」：本次已通过则直接开始；尚未返回则只在开始按钮上短暂等待，不进开通页、不大弹窗。失败才有感，并按第 5.4 节分类提示。
5. 过期只拦压缩，不删本机文件，不强迫退出。
6. 压缩进行中第一期不必反复校验。

---

## 9. 安全与部署假设

- 全站 HTTPS。管理接口与客户端接口隔离。
- 管理令牌至少 32 字节随机，可再加 IP 白名单。应用账号只授这三张表的 DML，DDL 走迁移（与数据模型第 7 节一致）。
- 过期只以数据库/服务端 UTC 时间为准，不信任客户端时钟。管理员指定截止日期时，按 Asia/Shanghai 当天结束时刻换算成 UTC 再写入。
- 第一期：一个 Go 二进制（或一张小镜像）+ MySQL 8，单机即可。域名、证书、是否走现有网关待确认。客户端 Base URL 做成可配置，正式包写入约定地址。
- 配置：`HTTP_ADDR`、`DATABASE_URL`、`ADMIN_API_TOKEN`、`LOG_LEVEL`。
- 每日备份；解绑不可从绑定表恢复，误操作靠审计追溯后手工处理。
- `/healthz`、`/readyz` + 结构化日志（脱敏）。

---

## 10. 验收用例（拍板后实现必须覆盖）

1. 新 Key + 新设备 `activate` 成功并绑定；随后 `validate` 成功。
2. 未激活，或本次 `validate` 未成功，不能开始压缩（客户端遵守）。
3. 断网、超时、5xx：客户端提示网络不通，不提示 Key 无效或过期；不得用上次成功放行。
4. 错误 Key、已停用 Key：`invalid`。
5. 已过期 Key：`expired`；绑定仍在；本机再 `activate` 另一枚（即便那枚也无效/过期）先返回 `device_bound_to_other_key`；延长有效期后原绑定 `validate` 通过。
6. 同一 Key 在第二台设备上 `activate`：`key_bound_to_other_device`。
7. 已绑定设备再 `activate` 另一枚有效 Key：`device_bound_to_other_key`。
8. 管理员解绑后，旧设备 `validate` 立即 `not_bound`，不自动重绑；旧设备再次 `activate` 原 Key（在新设备尚未绑上时）可绑回（基线行为）。
9. 解绑后新设备用原 Key `activate` 成功。
10. 模拟重装（安装 ID 变化、指纹变了）：`validate` 失败；不解绑则原 Key 仍被旧指纹占用；解绑后新指纹可 `activate` 原 Key。
11. 两台设备同时 `activate` 同一枚未绑定 Key：只有一个成功，另一个得到 `key_bound_to_other_device`。
12. 管理接口无令牌不可用。

---

## 11. 待确认项

已定、不再待确认：Go + Gin；库用 MySQL 8；三张表为基线；`activate` / `silent` 分工；结果码分类不合并；本机已绑定再输入另一枚时优先 `device_bound_to_other_key`；指纹用 `kuaiyaya.v1` + 硬件 UUID + 本机安装 ID 的哈希；盐值拼写为 `kuaiyaya.v1`。

仍待确认（不影响先审方案）：

1. 部署位置、域名、是否已有统一网关和证书。
2. 第一期管理是否只提供 API + 脚本（本文默认是），还是需要极简内部管理页。
3. 列表接口是否回显完整 `key_code`（本文按数据模型「可重发原 Key」默认回显，仅限管理令牌）。

未决文档工作（不挡本次送审，但两边需要改回同一套）：数据模型第 4 节、客户端方案第 8.1 节目前仍写钥匙串随机 UUID，请改回第 6 节算法。

---

## 12. 建议实现顺序（拍板后再动）

1. 按定稿后的 `data-model.md` 做迁移。
2. 领域逻辑与单测：第 5.1 节顺序、过期、并发绑定、`silent` 不落绑定。
3. Gin API、限流、管理鉴权、日志脱敏。
4. 部署与健康检查。
5. 与客户端按本契约联调第 10 节用例。

技术方案未经昆哥拍板前，不写业务代码、不建生产库、不对外暴露服务。
