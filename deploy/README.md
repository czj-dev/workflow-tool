# build/

构建脚本。bash 编写：Windows 用 Git Bash 运行，macOS / Linux 原生支持。
脚本用 `BASH_SOURCE` 自定位，从任意目录调用均可。

## 前置

- Go、Node.js
- wails3 CLI（锁定 `v3.0.0-alpha2.119`，CLI 与库同版本，**勿升 alpha.3**）：

  ```bash
  go install github.com/wailsapp/wails/v3/cmd/wails3@v3.0.0-alpha2.119
  ```

## 用法

```bash
bash build/build.sh        # 全量：前端 → bindings → 单二进制
bash build/frontend.sh     # 仅前端（总是 npm install 同步依赖；bindings 自动生成）
bash build/backend.sh      # 仅后端（bindings + go build；需 frontend/dist 已就绪）
```

> macOS / Linux 首次需 `chmod +x build/*.sh`，之后可直接 `./build/build.sh`。

## 产物

| 路径 | 说明 |
|---|---|
| `frontend/dist/` | 前端产物，embed 进二进制 |
| `frontend/bindings/` | wails3 生成的前端绑定（gitignored） |
| `workflow-tool(.exe)` | 最终单二进制（项目根） |

## 平台

| 平台 | 产物 | 备注 |
|---|---|---|
| Windows | `workflow-tool.exe` | `-H windowsgui` 隐藏控制台；编译前自动 `taskkill` 释放占用 |
| macOS / Linux | `workflow-tool` | 普通二进制 |

## 何时重跑 bindings

改了 [internal/api/api.go](../internal/api/api.go) 的 Service 方法签名或类型后**必须**重跑
（`build.sh` / `backend.sh` 已含此步；或单独 `wails3 generate bindings`），
否则前端调用报 `method ID not found`。之后须重新 `npm run build` → `go build`。
