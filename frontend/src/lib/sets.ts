// 不可变 Set 小工具：两页的分区折叠态（collapsed）都是「键在集合里 = 收起」的
// 集合状态，切换 / 移除统一走这里，各处不再手写 new Set + delete/add 样板。

/** 键切换：在集合里则移除（展开），不在则加入（收起）。 */
export function toggleInSet<T>(set: ReadonlySet<T>, key: T): ReadonlySet<T> {
  const next = new Set(set);
  if (!next.delete(key)) next.add(key);
  return next;
}

/** 键移除（单向，不切换）：「保证某分区展开」这类只删不加的操作。 */
export function removeFromSet<T>(set: ReadonlySet<T>, key: T): ReadonlySet<T> {
  const next = new Set(set);
  next.delete(key);
  return next;
}
