# deploy/

构建与打包脚本。bash 编写：Windows 用 Git Bash 运行，macOS / Linux 原生支持。
脚本用 `BASH_SOURCE` 自定位，从任意目录调用均可。

## 脚本一览

| 脚本 | 作用 |
|---|---|
| `build.sh` | 全量：先跑 `frontend.sh`，再跑 `backend.sh` |
| `frontend.sh` | 仅前端：生成 bindings → `npm install` → `npm run build` |
| `backend.sh` | 仅后端：生成 bindings → `go build`（需 `frontend/dist/` 已就绪） |
| `macos-app.sh` | 仅 macOS：把二进制打成 `WorkflowTool.app`，见 [assets/README.md](../assets/README.md)「macOS .app 打包」 |
| `make-icons.sh` | 改了 `assets/icon.svg` 后重新生成图标产物，见 [assets/README.md](../assets/README.md)「改图后重新生成」 |

## 前置

- Go 1.25+、Node.js 20.19+ 或 22.13+（见根 [README](../README.md)）
- wails3 CLI（锁定 `v3.0.0-alpha2.119`，CLI 与库同版本，**勿升 alpha.3**）：

  ```bash
  go install github.com/wailsapp/wails/v3/cmd/wails3@v3.0.0-alpha2.119
  ```

  它装在 `$(go env GOPATH)/bin`。`frontend.sh` 和 `backend.sh` 都会自动把这个目录加进 `PATH`，`go install` 装好就能被找到。

## 用法

```bash
bash deploy/build.sh        # 全量：bindings → 前端 → 单二进制
bash deploy/frontend.sh     # 仅前端（总是 npm install 同步依赖；bindings 自动生成）
bash deploy/backend.sh      # 仅后端（bindings + go build；需 frontend/dist 已就绪）
```

> macOS / Linux 首次需 `chmod +x deploy/*.sh`（入库的 `build.sh` / `frontend.sh` / `backend.sh` / `make-icons.sh` 没有可执行位），之后可直接 `./deploy/build.sh`。

## 顺序

`wails3 generate bindings` → `npm run build` → `go build`，不能乱：前端 import `frontend/bindings/`（gitignored 的生成物，新克隆后要先跑 `frontend.sh` 才有），前端产物又 embed 进二进制。三个脚本都已按这个顺序编排；手工构建的写法见根 [README](../README.md)「手动构建」。

## 产物

| 路径 | 说明 |
|---|---|
| `frontend/dist/` | 前端产物，embed 进二进制 |
| `frontend/bindings/` | wails3 生成的前端绑定（gitignored） |
| `workflow-tool(.exe)` | 最终单二进制（项目根） |
| `WorkflowTool.app/` | macOS 应用包（项目根，`macos-app.sh` 产出，不入库） |

## 平台

| 平台 | 产物 | 备注 |
|---|---|---|
| Windows | `workflow-tool.exe` | `-H windowsgui` 隐藏控制台；编译前自动 `taskkill` 释放占用 |
| macOS / Linux | `workflow-tool` | 普通二进制；macOS 另可跑 `macos-app.sh` 打成 `.app`（需 `rsvg-convert`） |

## 何时重跑 bindings

改了 [internal/api/](../internal/api/) 下任意域文件的 Service 方法签名或类型后**必须**重跑
（三个脚本都已含此步；或单独 `wails3 generate bindings`），
否则前端调用报 `method ID not found`。之后须重新 `npm run build` → `go build`。
