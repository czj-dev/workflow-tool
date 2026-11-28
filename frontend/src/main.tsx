import "./i18n"
import { StrictMode } from "react"
import { createRoot } from "react-dom/client"

import "./index.css"
import App from "./App.tsx"
import { ThemeProvider } from "@/components/theme-provider.tsx"
import { isProtoRequested } from "./components/config-pages.prototype/session.ts"

// dev 专用 mockup 入口：?mockup=ai 渲染 AI 输出面板设计稿、?mockup=logcat-link 渲染
// logcat 连接符机制设计稿（动态 import，不进主 bundle）
const mockup = new URLSearchParams(location.search).get("mockup")
if (mockup === "ai") {
  import("./components/ai/AiOutputMockup").then(({ AiOutputMockup }) => {
    createRoot(document.getElementById("root")!).render(
      <StrictMode>
        <AiOutputMockup />
      </StrictMode>
    )
  })
} else if (mockup === "logcat-link") {
  import("./components/LogcatLinkMockup").then(({ LogcatLinkMockup }) => {
    createRoot(document.getElementById("root")!).render(
      <StrictMode>
        <LogcatLinkMockup />
      </StrictMode>
    )
  })
} else if (import.meta.env.DEV && isProtoRequested()) {
  // dev 专用原型入口（一次性）：?variant=A|B|C 时先把 Wails transport 换成内存桩
  //（真实数据的形状与体量，但不读盘 / 不写文件 / 不执行运行），再照常挂载应用。
  // 桩装好之前不渲染，保证首个绑定调用就走桩。生产构建里 DEV 为 false，整段连同 import 被剔除。
  import("./components/config-pages.prototype/stub").then(({ installStub }) => {
    installStub()
    createRoot(document.getElementById("root")!).render(
      <StrictMode>
        <ThemeProvider>
          <App />
        </ThemeProvider>
      </StrictMode>
    )
  })
} else {
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <ThemeProvider>
        <App />
      </ThemeProvider>
    </StrictMode>
  )
}
