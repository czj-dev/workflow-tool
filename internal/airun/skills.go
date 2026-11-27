// skills.go 提供 skill 的零拷贝解析（设计 §5，ADR-0008）：任务绑定的 skill ids
// 解析为 registry 扫描出的源目录，经 --skill <dir> 直读，不再复制到 CLI 约定目录。
// skills.synced.json 停写，历史文件留着不动；project/user 作用域区别随复制目标
// 一起消失（源目录都来自注册表 meta.Dir）。
package airun

import (
	"fmt"

	"workflow-tool/internal/registry"
)

// SkillDirResolver 返回一个 SkillDirs 函数（挂 Deps，api / cli 注入）：把绑定的
// skill ids 按声明顺序解析为源目录。skills 是注册表的惰性快照——api 侧随热重载
// 更新，每次解析都重取。源缺失（加载后被移动/删除）返回 error——skill 是声明的
// 依赖，运行失败。
func SkillDirResolver(skills func() map[string]registry.SkillMeta) func(ids []string) ([]string, error) {
	return func(ids []string) ([]string, error) {
		metas := skills()
		dirs := make([]string, 0, len(ids))
		for _, id := range ids {
			meta, ok := metas[id]
			if !ok {
				return nil, fmt.Errorf("skill %q 不存在（skills/ 加载后被移动或删除），请重新加载任务", id)
			}
			dirs = append(dirs, meta.Dir)
		}
		return dirs, nil
	}
}
