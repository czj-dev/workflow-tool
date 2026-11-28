import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  GetVariableGroups,
  SetVariableGroups,
} from "../../bindings/workflow-tool/internal/api/service.js";
import type { VariableGroup } from "../../bindings/workflow-tool/internal/registry/models.js";
import { AMB_COLORS, type AmbColor } from "../components/config-pages/colors";

// 页面级专用 hook（规格 C）：只有全局配置页消费，不并入 ActionRunnerProvider 的
// 启动加载——Provider 多调一个绑定会让 23 个测试文件的 mock 全部失败。
// 变量分组即时落盘（写穿式）：本地先更新 → SetVariableGroups → 用返回值替换本地
// 状态；失败回滚到操作前并报一行错误（下一次成功写入后清除）。写入带序号，
// 迟到的旧响应不覆盖更新的本地状态。
//
// 载荷规整（规格 A）：每次提交整份状态，并丢弃「页面上没有对应行、且已保存的
// 全局配置里也已不存在」的成员——已删除的变量不再留在文件里；未保存的草稿行
// 照常提交。pageKeys / savedKeys 由页面在调用时构建。

/** 写入时的过滤上下文：pageKeys = 草稿行键（trim 后非空），savedKeys = 已保存配置的键。 */
export interface GroupWriteCtx {
  pageKeys: ReadonlySet<string>;
  savedKeys: ReadonlySet<string>;
}

/** 分组的显示色：色卡五色之外的值（含未设置）按蓝色显示（规格 E）。 */
export function displayAmbColor(color: string | undefined): AmbColor {
  return AMB_COLORS.includes(color as AmbColor) ? (color as AmbColor) : "blue";
}

/** 新分组默认色：五色里第一个还没被占用的；都占用了取「最久没用过的那色」
 * （按分组顺序，最后一次出现的位置最靠前），平手按色卡顺序（规格 E）。 */
export function pickDefaultColor(groups: VariableGroup[]): AmbColor {
  const lastUsedAt = (color: AmbColor) => {
    let at = -1;
    groups.forEach((g, i) => {
      if (displayAmbColor(g.color) === color) at = i;
    });
    return at;
  };
  let best: AmbColor = AMB_COLORS[0];
  for (const color of AMB_COLORS) {
    if (lastUsedAt(color) < lastUsedAt(best)) best = color;
  }
  return best;
}

export function useVariableGroups() {
  const { t } = useTranslation();
  // groupsRef 与 state 同步维护：写穿操作需要在 setState 之外同步读到「当前值」
  // 来计算下一份状态与回滚基准，React 的函数式 setState 更新器做不到这一点。
  const groupsRef = useRef<VariableGroup[]>([]);
  const [groups, setGroups] = useState<VariableGroup[]>([]);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);

  useEffect(() => {
    let cancelled = false;
    GetVariableGroups()
      .then((loaded) => {
        if (cancelled) return;
        groupsRef.current = loaded ?? [];
        setGroups(groupsRef.current);
      })
      // 读失败视为没有分组（后端对坏文件也返回空）：页面照常可用，不报错
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const apply = useCallback(
    (ctx: GroupWriteCtx, mutate: (prev: VariableGroup[]) => VariableGroup[]) => {
      const before = groupsRef.current;
      // 丢弃页面上没有对应行、且已保存配置里也已不存在的成员
      const next = mutate(before).map((g) => ({
        ...g,
        keys: (g.keys ?? []).filter((k) => ctx.pageKeys.has(k) || ctx.savedKeys.has(k)),
      }));
      const mySeq = ++seq.current;
      groupsRef.current = next;
      setGroups(next);
      SetVariableGroups(next)
        .then((saved) => {
          if (seq.current !== mySeq) return; // 迟到响应：本地已有更新，不覆盖
          groupsRef.current = saved ?? [];
          setGroups(groupsRef.current);
          setError(null);
        })
        .catch((e: unknown) => {
          if (seq.current !== mySeq) return;
          groupsRef.current = before; // 回滚到操作前
          setGroups(before);
          setError(
            t("global.groupsSaveFailed", {
              error: e instanceof Error ? e.message : String(e),
            }),
          );
        });
    },
    [t],
  );

  const create = useCallback(
    (name: string, color: AmbColor, ctx: GroupWriteCtx) =>
      apply(ctx, (prev) => [...prev, { name, color, keys: [] }]),
    [apply],
  );

  const rename = useCallback(
    (oldName: string, newName: string, color: AmbColor, ctx: GroupWriteCtx) =>
      apply(ctx, (prev) =>
        prev.map((g) => (g.name === oldName ? { ...g, name: newName, color } : g)),
      ),
    [apply],
  );

  const setColor = useCallback(
    (name: string, color: AmbColor, ctx: GroupWriteCtx) =>
      apply(ctx, (prev) => prev.map((g) => (g.name === name ? { ...g, color } : g))),
    [apply],
  );

  /** 移入分组；target = null 表示移回「未分组」（从所有分组里移除）。 */
  const move = useCallback(
    (key: string, target: string | null, ctx: GroupWriteCtx) =>
      apply(ctx, (prev) => {
        const cleaned = prev.map((g) => ({
          ...g,
          keys: (g.keys ?? []).filter((k) => k !== key),
        }));
        return target
          ? cleaned.map((g) =>
              g.name === target ? { ...g, keys: [...(g.keys ?? []), key] } : g,
            )
          : cleaned;
      }),
    [apply],
  );

  /** 删除分组（成员回到「未分组」，无需确认）。 */
  const remove = useCallback(
    (name: string, ctx: GroupWriteCtx) =>
      apply(ctx, (prev) => prev.filter((g) => g.name !== name)),
    [apply],
  );

  return { groups, error, create, rename, setColor, move, remove };
}
