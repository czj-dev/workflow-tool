import { useActionRunner } from "../hooks/useActionRunner";
import { YamlEditor } from "./YamlEditor";

// Workflow yaml 编辑入口：把 ActionRunnerProvider 的 workflow 数据绑定进共享 YamlEditor。
// 退出回到该 workflow 的 Pipeline 视图（workflow）。
export function WorkflowYamlEditor() {
  const { workflows, currentId, getWorkflowYaml, saveWorkflowYaml, setView } =
    useActionRunner();
  return (
    <YamlEditor
      kind="workflow"
      items={workflows}
      currentId={currentId}
      getYaml={getWorkflowYaml}
      saveYaml={saveWorkflowYaml}
      onExit={() => setView("workflow")}
    />
  );
}
