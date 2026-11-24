import { useActionRunner } from "../hooks/useActionRunner";
import { YamlEditor } from "./YamlEditor";

// AI 任务 yaml 编辑入口：把 ActionRunnerProvider 的 AI 任务数据绑定进共享 YamlEditor。
// 退出回到该任务的会话页（ai-chat）。
export function AiYamlEditor() {
  const { aiTasks, currentId, getAiYaml, saveAiYaml, setView } = useActionRunner();
  return (
    <YamlEditor
      kind="ai"
      items={aiTasks}
      currentId={currentId}
      getYaml={getAiYaml}
      saveYaml={saveAiYaml}
      onExit={() => setView("ai-chat")}
    />
  );
}
