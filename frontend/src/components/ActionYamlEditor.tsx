import { useActionRunner } from "../hooks/useActionRunner";
import { YamlEditor } from "./YamlEditor";

// Action yaml 编辑入口：把 ActionRunnerProvider 的 action 数据绑定进共享 YamlEditor。
// 退出回到该 action 的输出视图（output）。
export function ActionYamlEditor() {
  const { actions, currentId, getActionYaml, saveActionYaml, setView } =
    useActionRunner();
  return (
    <YamlEditor
      kind="action"
      items={actions}
      currentId={currentId}
      getYaml={getActionYaml}
      saveYaml={saveActionYaml}
      onExit={() => setView("output")}
    />
  );
}
