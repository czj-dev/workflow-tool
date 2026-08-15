// 真实 LLM stream-json 抓取样例（claude CLI 与 LLMRunner 同款 flags：
// -p --output-format=stream-json --verbose --thinking enabled），
// prompt「读一下当前目录的 package.json，告诉这个项目用了哪个 react 版本和构建工具，各一行。先看文件再说。」
// 事件字段原样保留；剔除本机 hook/thinking_tokens/notification 噪音（ducc 场景不存在）。
// atMs 是回放时间轴（毫秒，相对会话开始）：真实 stream-json 不带 per-event 时间戳，
// 这里按事件顺序与真实 duration_ms=18878 的比例编排，并把 thinking/text 切成多块模拟流式增量。
export const MOCK_PROMPT =
  "读一下当前目录的 package.json，告诉这个项目用了哪个 react 版本和构建工具，各一行。先看文件再说。"

export interface MockStreamEvent {
  atMs: number
  line: string // 一行原始 stream-json
}

export const MOCK_STREAM_EVENTS: MockStreamEvent[] = [
  {
    atMs: 0,
    line: JSON.stringify({
      type: "system",
      subtype: "init",
      session_id: "8fded80a-404b-41f8-b6b6-8ca6eea4edb7",
      model: "claude-opus-4-5",
      tools: ["/Read", "/Bash", "/Grep", "/Glob", "…44 个"],
      cwd: "C:\\Users\\ASUS\\AppData\\Local\\Temp\\llm-mock",
    }),
  },
  {
    atMs: 300,
    line: JSON.stringify({
      type: "assistant",
      message: {
        content: [
          {
            type: "thinking",
            thinking:
              "The user asks me to read the package.json in the current directory and tell them which react version and build tool this project uses, one line each, and to look at the file first before answering.",
          },
        ],
      },
    }),
  },
  {
    atMs: 1100,
    line: JSON.stringify({
      type: "assistant",
      message: {
        content: [
          {
            type: "thinking",
            thinking:
              "\n\nThis is a simple file-reading task. Let me first check the contents of package.json before answering.",
          },
        ],
      },
    }),
  },
  {
    atMs: 2600,
    line: JSON.stringify({
      type: "assistant",
      message: {
        content: [
          {
            id: "call_4a838ba9f38949edb4f39092",
            type: "tool_use",
            name: "Read",
            input: {
              file_path: "C:\\Users\\ASUS\\AppData\\Local\\Temp\\llm-mock\\package.json",
            },
          },
        ],
      },
    }),
  },
  {
    atMs: 3900,
    line: JSON.stringify({
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "call_4a838ba9f38949edb4f39092",
            content:
              '1\t{\n2\t  "name": "frontend",\n3\t  "private": true,\n4\t  "version": "0.0.1",\n5\t  "type": "module",\n6\t  "scripts": {\n7\t    "dev": "vite",\n8\t    "build": "tsc -b && vite build",\n9\t    "lint": "eslint .",\n10\t    "test": "vitest",\n11\t  …\n  "dependencies": {\n    "react": "^19.2.6",\n    "react-dom": "^19.2.6",\n  },\n  "devDependencies": {\n    "vite": "^8.0.0",\n    "@vitejs/plugin-react": "^8.0.0",\n    "vitest": "^3.2.0",\n  }\n}',
          },
        ],
      },
    }),
  },
  {
    atMs: 4300,
    line: JSON.stringify({
      type: "assistant",
      message: {
        content: [{ type: "thinking", thinking: "用户要两行信息：react 版本和构建工具。" }],
      },
    }),
  },
  {
    atMs: 5000,
    line: JSON.stringify({
      type: "assistant",
      message: {
        content: [{ type: "text", text: "- React 版本：`^19.2.6`（react / react-dom 均为 19.x）\n" }],
      },
    }),
  },
  {
    atMs: 6200,
    line: JSON.stringify({
      type: "assistant",
      message: {
        content: [{ type: "text", text: "- 构建工具：" }],
      },
    }),
  },
  {
    atMs: 7100,
    line: JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "Vite `^8`（配合 `@vitejs/plugin-react`，测试用 vitest）" },
        ],
      },
    }),
  },
  {
    atMs: 7600,
    line: JSON.stringify({
      type: "result",
      subtype: "success",
      duration_ms: 18878,
      duration_api_ms: 11030,
      num_turns: 2,
      total_cost_usd: 0.129653,
      usage: {
        input_tokens: 21292,
        cache_read_input_tokens: 36736,
        output_tokens: 193,
      },
      result:
        "- React 版本：`^19.2.6`（react / react-dom 均为 19.x）\n- 构建工具：Vite `^8`（配合 `@vitejs/plugin-react`，测试用 vitest）",
    }),
  },
]
