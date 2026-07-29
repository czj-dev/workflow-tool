import { useContext } from "react";
import {
  RunnerContext,
  type RunnerContextValue,
} from "../context/ActionRunnerProvider";

export function useActionRunner(): RunnerContextValue {
  const ctx = useContext(RunnerContext);
  if (!ctx) {
    throw new Error("useActionRunner 必须在 ActionRunnerProvider 内使用");
  }
  return ctx;
}
