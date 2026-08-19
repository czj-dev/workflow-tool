import "./i18n"
import { StrictMode } from "react"
import { createRoot } from "react-dom/client"

import "./index.css"
import App from "./App.tsx"
import { ThemeProvider } from "@/components/theme-provider.tsx"

// dev 专用 mockup 入口：?mockup=llm 渲染 LLM 输出面板设计稿、?mockup=logcat-link 渲染
// logcat 连接符机制设计稿（动态 import，不进主 bundle）
const mockup = new URLSearchParams(location.search).get("mockup")
if (mockup === "llm") {
  import("./components/llm/LlmOutputMockup").then(({ LlmOutputMockup }) => {
    createRoot(document.getElementById("root")!).render(
      <StrictMode>
        <LlmOutputMockup />
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
} else {
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <ThemeProvider>
        <App />
      </ThemeProvider>
    </StrictMode>
  )
}
