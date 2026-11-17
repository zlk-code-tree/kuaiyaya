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
# macOS 和 Windows 默认使用云端服务；本机联调可按需覆盖：
# export KUAIYAYA_API_BASE=http://127.0.0.1:8080
npm run dev
```

开发模式下，若 `app/resources/ffmpeg/darwin-arm64/` 里还没有二进制，会回退到 PATH 中的 `ffmpeg` / `ffprobe`，仅供本机联调。正式包不会走这条路径。

客户端还会在用户数据目录写入 `config.json`（只放 `apiBaseUrl`，不放 Key）。也可以用环境变量 `KUAIYAYA_API_BASE`。

macOS 和 Windows 默认服务地址均为 `http://8.140.245.64/kuaiyaya`。已有的 `config.json` 会覆盖默认值；如此前设置为本机服务，需修改或移除旧设置后重启。当前云服务使用 HTTP，Key 和设备标识在传输过程中未加密；应在配置有效 HTTPS 域名后改用 HTTPS。

钥匙串只在 macOS 上写入。Linux 开发机不会把 Key 写进明文配置，只用于无法实测钥匙串的情况。

### 压缩前分析画质

选择视频并设置目标后，可点击「分析画质」。应用在本机抽取不同位置的短片段，分别按当前目标和一个较大的备选目标试压，展示样片评分、粗略的全片体积估计和建议目标；可以应用建议，也可以保留原目标。分析需要有效 Key，可随时取消，临时文件会清理。

画质比较优先使用 FFmpeg 的 `libvmaf`，不可用时回退 `ssim`。在硬件试压结果偏低且可用软件编码时，会进一步比较 `libx265` 的样片；正式压缩沿用选中的编码器。分数和体积均为抽样估计，建议检查输出中的小字、字幕和动态画面；抽样结果不是全片画质或体积的保证。为得到结果可能需要额外时间和临时磁盘空间。

### 版本检查与发布

从 `1.0.1` 开始，客户端在启动约 5 秒后及运行期间每 12 小时检查一次；「关于」中也可手动检查。发现新版本后，在标题栏显示入口，用户自行前往下载并安装。压缩或画质分析期间入口会暂时隐藏，检查失败不会打断操作。当前不提供自动下载安装。

已经安装的 `1.0.0` 没有更新检查功能，需要先手动安装一次 `1.0.1`；之后的版本才能收到提示。升级应保持应用标识和用户数据位置，并在 macOS、Windows 上验证钥匙串／DPAPI 和已有 Key 可继续使用。

发布新版本的步骤：

1. 在 `app/` 更新版本号（例如 `npm version patch --no-git-tag-version`，会同步更新 `package.json` 和 `package-lock.json`），然后按下文分别打 macOS 和 Windows 安装包。版本只支持 `主版本.次版本.修订号`，例如 `1.0.2`。
2. 把完整安装包上传到用户可访问的 HTTPS 地址，并先验证能下载。macOS 和 Windows 可分别发布不同版本。
3. 在服务端机器复制 `server/releases.example.json`，将其中的示例地址、版本号和更新说明改为真实值，保存到部署目录（例如 `/opt/kuaiyaya/releases.json`）。每个 `platform` / `arch` 组合最多一条；未发布的平台可以不写。请勿把示例域名作为实际下载地址。
4. 在服务端环境中设置 `UPDATE_MANIFEST_PATH=/opt/kuaiyaya/releases.json` 并重启服务。其后每次发布先上传包，再将新 JSON 写成同目录临时文件并用原子重命名替换；服务会在每次检查时重新读取，不必重启。

检查接口例如 `GET /v1/app/releases/latest?platform=darwin&arch=arm64`，Windows 使用 `platform=win32&arch=x64`。未配置清单或对应平台未发布时返回空数据；配置的文件不存在、格式有误或下载地址不是 HTTPS 时返回服务不可用。清单只包含公开发布信息，不要写入管理员令牌或 Key。

客户端复用 `apiBaseUrl` 访问版本接口：生产环境应配置为用户能访问的 HTTPS 服务地址；HTTP 仅允许用于本机回环开发。安装包下载由系统浏览器打开，请确保下载地址可供目标用户访问。版本检查与自动更新安装是不同功能；以后如需自动覆盖安装，macOS 签名和 Windows 安装包类型还需另行调整。

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

Windows 正式版默认 Key 服务地址为 `http://8.140.245.64/kuaiyaya`。该地址目前使用 HTTP，Key 和设备标识在传输过程中未加密；云端配置好有效的 HTTPS 域名后应改用 HTTPS 并重新发布。若要指定其他服务，请在首次启动后退出应用，编辑 `%APPDATA%\快鸭鸭\config.json`（没有此文件时新建）：

```json
{"apiBaseUrl":"https://你的服务域名/kuaiyaya"}
```

已有 `config.json` 优先于环境变量和默认地址，升级不会自动覆盖它；若旧配置仍指向 `127.0.0.1`，请按上面修改或移除该设置后重启。云端版本检查要求 HTTPS，且云服务需要部署版本检查接口并发布版本清单。

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
