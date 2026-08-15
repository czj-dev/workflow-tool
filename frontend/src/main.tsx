import "./i18n"
import { StrictMode } from "react"
import { createRoot } from "react-dom/client"

import "./index.css"
import App from "./App.tsx"
import { ThemeProvider } from "@/components/theme-provider.tsx"

// dev 专用 mockup 入口：?mockup=llm 渲染 LLM 输出面板设计稿（动态 import，不进主 bundle）
if (new URLSearchParams(location.search).get("mockup") === "llm") {
  import("./components/llm/LlmOutputMockup").then(({ LlmOutputMockup }) => {
    createRoot(document.getElementById("root")!).render(
      <StrictMode>
        <LlmOutputMockup />
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
