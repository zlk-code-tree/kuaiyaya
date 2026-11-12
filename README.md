# 快鸭鸭

本机视频压缩桌面应用（第一期）。拖入一支视频，按目标大小压成 1080p HEVC mp4。文件全程不上传；与服务端的来往只用于 Key 校验。

维护者：黑曼巴的紫金王朝。反馈邮箱：zhanglikunmamba@gmail.com。

第一期范围与约定见 `docs/`（产品方案、客户端技术方案、Key 服务方案、数据模型，以及已拍板原型）。

## 仓库结构

- `app/`：Electron + TypeScript 桌面端（主进程负责文件、ffmpeg、钥匙串和 Key API，渲染进程只走 preload 白名单 IPC）
- `server/`：Go + Gin 的 Key 校验服务，以及极简管理页
- `docs/`：已审方案与原型
- `scripts/`：获取 ffmpeg 二进制、本地检查脚本

## 已拍板的实现约定（摘要）

- 支持 macOS Apple 芯片（`darwin-arm64`，最低 macOS 13）和 Windows x64；当前构建均未签名。
- 压缩默认走最快路径：探测到 `hevc_videotoolbox` 就硬编，没有或失败回退 `libx265` 软编。使用画质分析后，会按试压结果选用编码器。
- 默认目标为原文件大小的一半，用户可调。目标体积**不得超过**；略超则最多自动再压一次。
- 输出：长边不超过 1920 的 HEVC `.mp4`，`-tag:v hvc1`，`+faststart`；小尺寸视频不放大。
- Key 必须联网校验。第一次输入走 `POST /v1/license/activate`（才会绑定）；之后打开直进主界面，后台 `POST /v1/license/validate`（必须带 key + deviceId，绝不自动重绑，不使用 `bind_token`）。
- macOS 设备指纹由 IOPlatformUUID 和系统卷 Volume UUID 计算；Windows 使用 MachineGuid 计算。系统重装可能改变设备标识，需要管理员解绑。
- Key 与 deviceId 在 macOS 使用钥匙串保存，在 Windows 使用系统 DPAPI 加密保存，不进明文配置。

## 在 Mac 上启动 Key 服务

本机可复用已有的 Docker 容器 `mysql8`（端口 3306）。需要 Go 1.22+。

1. 在 MySQL 中建库（按实际 root 密码修改）：

```bash
docker exec -it mysql8 mysql -uroot -p -e \
  "CREATE DATABASE IF NOT EXISTS kuaiyaya CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;"
```

2. 配置环境变量：

```bash
cd server
cp .env.example .env
# 编辑 .env：DATABASE_URL、ADMIN_API_TOKEN（请改成至少 32 字节的随机串）、HTTP_ADDR
```

3. 迁移并启动（`AUTO_MIGRATE=true` 时启动即建表；也可只跑迁移）：

```bash
cd server
go run ./cmd/keyserver -migrate   # 可选，只建表
go run ./cmd/keyserver            # 默认监听 127.0.0.1:8080
```

健康检查：`GET /healthz`（进程存活）、`GET /readyz`（能连上数据库）。

### 发放 Key

打开管理页：浏览器访问 `http://127.0.0.1:8080/admin`，用 `ADMIN_API_TOKEN` 登录。可设置有效期、领取人和备注，查看绑定，解绑或停用。

也可以调用管理 API（把令牌换成你的）：

```bash
curl -s -X POST http://127.0.0.1:8080/v1/admin/keys \
  -H "Authorization: Bearer $ADMIN_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"count":1,"issuedTo":"试用","remark":"内部","expiresAt":"2027-01-01"}'
```

Key 形态为 `KYDY-XXXX-XXXX-XXXX`。把原文发给试用者，打开快鸭鸭后在开通页输入即可。

## 运行桌面端（开发模式）

需要 Node.js 20+，以及本机或随包的 ffmpeg / ffprobe。

```bash
# 1. 准备 ffmpeg（正式包必须随包，不依赖系统安装）
./scripts/fetch-ffmpeg.sh

# 2. 安装依赖并启动
cd app
npm install
# 接口地址默认 http://127.0.0.1:8080，可按需覆盖：
# export KUAIYAYA_API_BASE=http://127.0.0.1:8080
npm run dev
```

开发模式下，若 `app/resources/ffmpeg/darwin-arm64/` 里还没有二进制，会回退到 PATH 中的 `ffmpeg` / `ffprobe`，仅供本机联调。正式包不会走这条路径。

客户端还会在用户数据目录写入 `config.json`（只放 `apiBaseUrl`，不放 Key）。也可以用环境变量 `KUAIYAYA_API_BASE`。

钥匙串只在 macOS 上写入。Linux 开发机不会把 Key 写进明文配置，只用于无法实测钥匙串的情况。

### 压缩前分析画质

选择视频并设置目标后，可点击「分析画质」。应用在本机抽取不同位置的短片段，分别按当前目标和一个较大的备选目标试压，展示样片评分、粗略的全片体积估计和建议目标；可以应用建议，也可以保留原目标。分析需要有效 Key，可随时取消，临时文件会清理。

画质比较优先使用 FFmpeg 的 `libvmaf`，不可用时回退 `ssim`。在硬件试压结果偏低且可用软件编码时，会进一步比较 `libx265` 的样片；正式压缩沿用选中的编码器。分数和体积均为抽样估计，建议检查输出中的小字、字幕和动态画面；抽样结果不是全片画质或体积的保证。为得到结果可能需要额外时间和临时磁盘空间。

## 打 darwin-arm64 包

```bash
./scripts/fetch-ffmpeg.sh
cd app
npm install
npm run pack:mac
```

产物在 `app/release/`。第一期不公证，内部试用时若提示「未识别的开发者」，在访达中右键打开并确认即可。

最低系统版本 macOS 13，架构仅 Apple 芯片。

## Windows x64 版本

Windows 版本以 ZIP 提供：完整解压后打开文件夹中的 `快鸭鸭.exe`。需要 64 位 Windows 10 或 Windows 11；当前使用 libx265 软件编码，首次开通及使用时需要连接 Key 服务。构建未签名，可能出现 Windows 安全提示。

默认 Key 服务地址为 `http://127.0.0.1:8080`，它指向运行应用的 Windows 电脑自身。若服务部署在其他电脑，请在首次启动后退出应用，编辑 `%APPDATA%\快鸭鸭\config.json`（没有此文件时新建）：

```json
{"apiBaseUrl":"http://服务端地址:8080"}
```

确保服务端监听可访问的地址并允许对应端口。跨网络部署时应使用 HTTPS。

构建时先运行 `./scripts/fetch-ffmpeg-windows.sh`，然后在 `app/` 运行 `npm install` 和 `npm run pack:win`。ZIP 生成于 `app/release/`。Windows 适配仍需在 Windows 实机验证开通、重启、压缩、取消和画质分析。

## 本地检查

```bash
# 服务端
cd server && go test ./... && go build -o /tmp/kuaiyaya-keyserver ./cmd/keyserver

# 桌面端（类型检查、lint、单元测试；Linux 上会用 libx265 跑一条合成短片，验证体积不得超过）
cd app && npm test && npm run typecheck && npm run lint
```

VideoToolbox 硬编和 macOS 钥匙串无法在 Linux 上实测，相关代码已做平台判断，需在 Apple 芯片 Mac 上再验一次。

## 许可证说明

随包 ffmpeg 需编入 `libx265`，通常是 GPL 构建。第一期仅内部试用，发放时请一并说明。
