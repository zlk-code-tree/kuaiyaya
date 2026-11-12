# 快鸭鸭第一期 · Key 校验服务数据模型与表结构

状态：待昆哥审核，通过前不写实现。  
范围：只覆盖门禁所需的数据模型、约束、设备指纹、绑定/解绑/校验落库规则；API 路径与服务拆分由 Go 方案主笔。  
依据：产品方案 1.0 `product-plan.md` 第 5.1.2 节及第 7.2 节已拍板规则。

## 1. 结论

第一期用 3 张表即可，不做账号、不存视频、不缓存「上次校验通过」作为离线通行证。

| 表 | 作用 |
| --- | --- |
| `license_keys` | Key 主数据：码、有效期、启用/停用、内部备注 |
| `device_bindings` | **当前**一对一绑定，一行就是一个有效占用 |
| `binding_audit_logs` | 绑定、解绑、校验结果的审计，供排查，不参与放行判断 |

硬约束全部用唯一索引兜底，不靠应用层「先查后写」：

- 一个 Key 同时只绑一台设备：`device_bindings.uk_key_id`
- 一台设备同时只匹配一个 Key：`device_bindings.uk_device_fingerprint`

其它已拍板规则的落法：

- **第一次成功校验即绑定**：仅在「显式开通」（用户输入 Key）且该 Key、该设备当前都无绑定时插入绑定行。
- **必须联网校验**：放行只看本次服务端结果；`last_seen_at` 只做审计，客户端不得用它离线放行。
- **过期只拦压缩**：过期用 `expires_at` 现算，不改状态、不自动解绑；绑定行保留，换另一枚 Key 仍须管理员先解绑。
- **解绑后旧电脑立刻不能再压缩**：管理员解绑 = 删除当前绑定行并写审计。之后旧设备的**静默校验不得自动重绑**，须返回未绑定类错误；只有用户再次显式输入 Key 才允许重新绑定。否则旧电脑后台静默校验会把 Key 抢回去，换机解绑会失效。
- **重装 / 换硬盘 / 标识变化**：视为新设备指纹；旧指纹仍占用该 Key，必须管理员解绑后，在本机重新输入原 Key。

库已确认：MySQL 8、InnoDB、`utf8mb4`，时间一律存 UTC（昆哥本机已在用）。

## 2. 范围与不做

**做**

- 管理员发放 Key、设置或延长有效期、停用 Key、解绑设备。
- 客户端联网校验合法性、有效期、一对一绑定。
- 区分业务错误，供客户端分开提示「网络不通」与「Key 无效或过期」。网络不通由客户端在连不上服务端时自行判定，库表不存这种失败（可选审计另计）。

**不做**

- 用户账号、登录、注册、个人中心。
- 视频文件或压缩任务数据。
- 客户端解绑、自动解绑、按过期自动解绑、因换机强制换发新 Key。
- 把历史校验成功记录当作离线通行证。

管理员侧鉴权建议用服务端配置的管理 Token（或等价的内部鉴权），不另建用户体系。具体鉴权方式由 Go 方案确定。

## 3. 表结构

命名风格按 MySQL 常规蛇形；主键均为无符号自增。所有时间字段为 `DATETIME(3)`，存 UTC，不做 `ON UPDATE CURRENT_TIMESTAMP`。

### 3.1 `license_keys`（Key 主表）

| 字段 | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| `id` | `BIGINT UNSIGNED` | PK，自增 | 内部主键，对外不暴露也可，由 API 约定 |
| `key_code` | `VARCHAR(64)` | 非空，唯一 | 发给用户的 Key。入库前去空格并统一大写，比较只走规范化后的值 |
| `status` | `TINYINT UNSIGNED` | 非空，默认 `1` | `1=启用`，`2=停用`。停用视为「无效」，不是「过期」 |
| `expires_at` | `DATETIME(3)` | 可空 | `NULL` 表示无期限。`UTC 当前时间 >= expires_at` 即过期。过期不改本字段、不改 `status`，延长有效期只需改这一列 |
| `issued_to` | `VARCHAR(128)` | 可空 | 内部领取人备注，不对客户端展示 |
| `remark` | `VARCHAR(255)` | 可空 | 内部备注 |
| `created_at` | `DATETIME(3)` | 非空 | 发放时间 |
| `updated_at` | `DATETIME(3)` | 非空 | 最后一次管理端变更 |

索引：

- `PRIMARY KEY (id)`
- `UNIQUE KEY uk_key_code (key_code)`

不物理删除 Key，停用即可，避免审计和误发回收对不上。

Key 不是登录密码，第一期内部小范围试用允许明文存储，方便管理员查看和重发同一枚 Key。不要做成不可逆哈希，否则解绑后无法把原 Key 再交给用户。

### 3.2 `device_bindings`（当前绑定，一对一）

只存**正在占用**的绑定。解绑删除行，不在本表做软删除，否则唯一约束难以表达「当前占用」。

| 字段 | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| `id` | `BIGINT UNSIGNED` | PK，自增 | |
| `key_id` | `BIGINT UNSIGNED` | 非空，唯一，FK → `license_keys.id` | 一个 Key 当前只能有一行 |
| `device_fingerprint` | `VARCHAR(64)` | 非空，唯一 | v1 指纹的 SHA-256 小写 hex（64 字符）。服务端只存哈希，不存原始硬件号或 Volume UUID |
| `device_label` | `VARCHAR(255)` | 可空 | 给管理员看的弱标识，如主机名、系统版本；禁止存明文硬件序列号 |
| `bound_at` | `DATETIME(3)` | 非空 | 第一次成功校验并绑定的时间 |
| `last_seen_at` | `DATETIME(3)` | 可空 | 最近一次**成功**校验时间，仅审计与后台查看。不得作为离线放行依据 |

索引与外键：

- `PRIMARY KEY (id)`
- `UNIQUE KEY uk_key_id (key_id)`
- `UNIQUE KEY uk_device_fingerprint (device_fingerprint)`
- `CONSTRAINT fk_bindings_key FOREIGN KEY (key_id) REFERENCES license_keys(id)`，删除限制为 `RESTRICT`

### 3.3 `binding_audit_logs`（审计，不参与放行）

| 字段 | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| `id` | `BIGINT UNSIGNED` | PK，自增 | |
| `key_id` | `BIGINT UNSIGNED` | 非空 | 即使 Key 后续停用也保留 |
| `key_code` | `VARCHAR(64)` | 非空 | 冗余当时的 Key，避免只靠 id 对不上发放记录 |
| `device_fingerprint` | `VARCHAR(64)` | 非空 | 当时的 v1 指纹哈希 |
| `event_type` | `VARCHAR(32)` | 非空 | 见下表 |
| `result_code` | `VARCHAR(32)` | 可空 | 与接口错误码对齐，如 `ok`、`expired`、`invalid` |
| `detail` | `VARCHAR(255)` | 可空 | 短说明，如「管理员解绑」「设备已绑定其他 Key」 |
| `created_at` | `DATETIME(3)` | 非空 | |

`event_type` 取值：

| 值 | 何时写入 |
| --- | --- |
| `bind` | 显式开通且首次成功校验，插入绑定行 |
| `unbind` | 管理员解绑，删除绑定行 |
| `validate_ok` | 已绑定本设备且本次校验通过（含过期前的静默校验成功） |
| `validate_fail` | 服务端明确拒绝（无效、过期、占用冲突、静默校验时未绑定等） |

索引：

- `PRIMARY KEY (id)`
- `INDEX idx_key_created (key_id, created_at)`
- `INDEX idx_fingerprint_created (device_fingerprint, created_at)`
- `INDEX idx_created (created_at)`

第一期体量小，校验成功/失败都记。建议保留至少 90 天，具体清理策略待定。审计失败不得回滚已经成功的绑定/解绑事务；校验主路径以绑定表为准。

### 3.4 建议 DDL

```sql
CREATE TABLE license_keys (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  key_code      VARCHAR(64)     NOT NULL,
  status        TINYINT UNSIGNED NOT NULL DEFAULT 1 COMMENT '1=启用 2=停用',
  expires_at    DATETIME(3)     NULL COMMENT 'UTC，NULL=无期限；now>=expires_at 即过期',
  issued_to     VARCHAR(128)    NULL,
  remark        VARCHAR(255)    NULL,
  created_at    DATETIME(3)     NOT NULL,
  updated_at    DATETIME(3)     NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_key_code (key_code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE device_bindings (
  id                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  key_id              BIGINT UNSIGNED NOT NULL,
  device_fingerprint  VARCHAR(64)     NOT NULL COMMENT 'SHA-256 hex，v1=kuaiyaya.v1|hw_uuid|os_install_id',
  device_label        VARCHAR(255)    NULL,
  bound_at            DATETIME(3)     NOT NULL,
  last_seen_at        DATETIME(3)     NULL COMMENT '仅审计，不作离线通行证',
  PRIMARY KEY (id),
  UNIQUE KEY uk_key_id (key_id),
  UNIQUE KEY uk_device_fingerprint (device_fingerprint),
  CONSTRAINT fk_bindings_key FOREIGN KEY (key_id) REFERENCES license_keys (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE binding_audit_logs (
  id                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  key_id              BIGINT UNSIGNED NOT NULL,
  key_code            VARCHAR(64)     NOT NULL,
  device_fingerprint  VARCHAR(64)     NOT NULL,
  event_type          VARCHAR(32)     NOT NULL,
  result_code         VARCHAR(32)     NULL,
  detail              VARCHAR(255)    NULL,
  created_at          DATETIME(3)     NOT NULL,
  PRIMARY KEY (id),
  KEY idx_key_created (key_id, created_at),
  KEY idx_fingerprint_created (device_fingerprint, created_at),
  KEY idx_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
```

## 4. 设备指纹

与 `key-service-plan.md` 第 6 节同一套。服务端不采集、不存储原始硬件序列号，只接收客户端按 v1 算法算好的哈希，写入 `device_bindings.device_fingerprint`，按字符串全等匹配。

**v1 算法（macOS 第一期，客户端计算）：**

```
device_fingerprint = SHA-256(
  "kuaiyaya.v1" + "|" + hw_uuid + "|" + os_install_id
) 的小写 hex（64 字符）
```

| 分量 | macOS 取值 | 作用 |
| --- | --- | --- |
| 盐值 / 标识 | 固定字符串 `kuaiyaya.v1`（不要写成 `kuayaya`） | 避免裸哈希与其它系统撞车 |
| `hw_uuid` | `IOPlatformUUID` | 挡住「把钥匙串或安装目录拷到另一台电脑仍占用绑定」 |
| `os_install_id` | 系统卷 Volume UUID | 重装系统、换硬盘、迁移导致安装标识变化时，指纹改变，须管理员解绑后重绑原 Key |

应用更新、正常重启：两个分量都不变，指纹不变，不必解绑。  
不要用 MAC 地址、主机名参与哈希。主机名等只放可选的 `device_label`。

API 字段名可以是 `deviceId` / `key`，库表仍用 `device_fingerprint` / `key_code`，由服务端做映射。`deviceId` 必须是 64 位小写 hex，否则按非法请求拒绝。服务端不再加盐、不重算。

客户端可以把算好的哈希放进钥匙串以免重复计算，**不能把自行生成的随机 UUID 当作绑定 ID**。指纹算法变更必须升版本并做迁移。第一期只定义 v1。

## 5. 绑定、解绑、校验的数据流程

放行与绑定必须在同一事务里读改，并依赖唯一索引处理并发。出现唯一冲突时，按下面的业务码返回，不要写成系统错误。

校验请求至少带：`key_code`、`device_fingerprint`、`mode`。`mode` 只有两种：

- `activate`：用户显式输入 Key（首次开通或解绑后重新输入）。
- `silent`：已记住 Key 后的后台静默校验，或点「开始压缩」时等待中的校验。

### 5.1 公共判定（两种 mode 相同）

按顺序，命中即停。**先看本机当前绑定，再校验新输入的 Key 是否有效或过期。**

1. 本指纹已绑定**其他** Key → `device_bound_to_other_key`（「本机已匹配其他 Key」）。  
   即使新输入的那枚不存在、已停用或已过期，也优先返回这一码，避免用户误以为只是 Key 打错。比较时用规范化后的 `key_code`：与当前绑定是同一枚则继续往下走。
2. Key 不存在，或 `status=停用` → `invalid`（客户端按「Key 无效或过期」提示）。
3. Key 已过期（`expires_at` 非空且 `now >= expires_at`）→ `expired`。  
   - 若当前绑定正是本设备（即用户仍在用已绑定的那一枚）：不删绑定行，不更新 `last_seen_at`。  
   - 若尚未绑定：不插入绑定。过期不能完成首次绑定。
4. 本 Key 已绑定**其他**指纹 → `key_bound_to_other_device`（换机/重装但未解绑）。

以上均写 `validate_fail` 审计。

### 5.2 已绑定本设备且未过期

更新 `last_seen_at`，写 `validate_ok`，返回 `ok`。`mode` 不影响结果。

### 5.3 本 Key、本指纹当前都无绑定，且 Key 启用未过期

- `activate`：插入 `device_bindings`，写 `bind` + `ok`，返回 `ok`。这就是「第一次成功校验即绑定」。
- `silent`：不插入绑定，返回 `not_bound`。覆盖两种情况：管理员刚解绑，旧电脑还在后台静默校验；或本地误存了尚未绑定的 Key。这样解绑后旧电脑不能立刻再压缩，也不会把 Key 抢回去。

### 5.4 管理员解绑

1. 按 `key_id`（或规范化后的 `key_code`）找到当前绑定行；没有则视为幂等成功。
2. 删除 `device_bindings` 行。
3. 写 `unbind` 审计（记下被解绑的指纹）。
4. 不改 Key 本身，不强制换发。原 Key 可立即被另一台设备以 `activate` 绑定，或在原设备上重新输入后绑定。

解绑没有「延迟生效」。旧设备下一次 `silent` 校验走 5.3，得到 `not_bound`，不能压缩。

### 5.5 管理端其它写操作

- 发放 Key：插入 `license_keys`，`key_code` 冲突则拒绝。
- 改有效期：只更新 `expires_at`、`updated_at`。把过期时间推后后，已绑定设备下次校验即可通过，不必解绑、不必换 Key。
- 停用 Key：`status=2`。已有绑定可先保留，校验一律 `invalid`；若要让该设备改绑其它 Key，须再解绑。建议停用与解绑分成两个明确操作，避免误伤。

## 6. 给 API 对齐的结果码

网络层失败（超时、DNS、连不上、HTTP 5xx 等）由客户端映射为「网络不通」，不要和服务端业务码混用。服务端能给出明确业务码时，从不用「网络不通」来表达。

| 结果码 | 含义 | 客户端提示归类 | 是否建立或保留绑定 |
| --- | --- | --- | --- |
| `ok` | 合法、未过期，且已绑定本设备（或本次 `activate` 刚绑定） | 通过，可压缩 | 是 |
| `invalid` | Key 不存在或已停用 | Key 无效或过期 | 否（不新建） |
| `expired` | Key 存在但已过期 | Key 无效或过期 | 已绑本设备则保留，未绑则不建 |
| `device_bound_to_other_key` | 本机已匹配另一枚 Key | 本机已匹配其他 Key | 保留原绑定 |
| `key_bound_to_other_device` | 该 Key 已绑其它设备 | 不能占用他人设备上的 Key；换机/重装须先解绑 | 保留原绑定 |
| `not_bound` | 静默校验时 Key 与设备都空闲（常见于刚解绑） | 不能压缩；不要当网络错误。可引导重新输入 Key | 不自动绑定 |

`invalid` 与 `expired` 对用户可以共用「Key 无效或过期」文案，但接口必须分开，便于后台统计和以后改文案。

## 7. 库侧部署假设

库选型已确认。其余与 Go 方案一并转昆哥拍板：

- 存储：MySQL 8 + InnoDB + `utf8mb4`。单库足够支撑内部小范围试用。
- 时钟：过期只以数据库/服务端 UTC 时间为准，不信任客户端时间。
- 连接：应用用最小权限账号，只授予这 3 张表的 DML；DDL 走迁移，不给应用账号。
- 备份：第一期至少每日备份；绑定行很少，但解绑不可恢复，误操作只能靠审计追溯后手工处理。
- 传输与落盘：对外 API 走 HTTPS；Key 明文存库，库访问和备份按内部敏感配置看管。
- 不做：读写分离、分库分表、Key 加密存储、离线许可证文件。

## 8. 待确认项

已作为服务端方案基线、本次不再待确认的：库用 MySQL 8；`silent` 不自动重绑；本机已绑定时再输入另一枚（含无效或过期）优先返回 `device_bound_to_other_key`；设备指纹采用 v1：`SHA-256("kuaiyaya.v1" + "|" + hw_uuid + "|" + os_install_id)` 小写 hex，`hw_uuid` 为 IOPlatformUUID，`os_install_id` 为系统卷 Volume UUID，服务端只存哈希。

下列不影响先审这套模型，但昆哥拍板后才能写实现：

1. **Key 格式**：原型演示为 `KYDY-xxxx-xxxx`。正式发放的前缀、长度、是否自动生成，请定一下；表字段按 64 字符预留。
2. **过期判定边界**：本文按 `now >= expires_at` 视为过期（到达即失效）。
3. **审计保留期**：建议 90 天，可改。

以上是数据模型和约束方案，API 路由、部署形态请 @go资深高级开发专家 主笔时对齐本文结果码与 `activate` / `silent` 两种 mode。
