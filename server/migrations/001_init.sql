-- 快鸭鸭第一期 Key 校验库表，与 docs/data-model.md 第 3.4 节 DDL 一致。
-- 库：MySQL 8 + InnoDB + utf8mb4_0900_ai_ci；时间一律存 UTC。

CREATE TABLE IF NOT EXISTS license_keys (
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

CREATE TABLE IF NOT EXISTS device_bindings (
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

CREATE TABLE IF NOT EXISTS binding_audit_logs (
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
