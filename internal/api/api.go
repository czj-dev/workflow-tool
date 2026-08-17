package api

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"sync"
	"time"

	"github.com/wailsapp/wails/v3/pkg/application"

	"workflow-tool/internal/adb"
	"workflow-tool/internal/adb/binary"
	"workflow-tool/internal/adb/device"
	"workflow-tool/internal/registry"
	"workflow-tool/internal/runner"
	"workflow-tool/internal/workflow"
)

// Service 是暴露给前端的 Wails 服务。
type Service struct {
	app       *application.App
	reg       *registry.Registry
	baseDir   string
	cfgPath   string // config.yaml 路径
	fragPath  string // fragments.yaml 路径
	global    map[string]string
	gMu       sync.Mutex // 保护 global 的读写
	fragments []registry.Fragment
	fMu       sync.Mutex // 保护 fragments 的读写
	mu        sync.Mutex
	running   map[string]context.CancelFunc // actionID -> cancel
	wfReg     *workflow.WorkflowRegistry
	wfMu      sync.Mutex
	wfRunning map[string]context.CancelFunc // workflowID -> cancel

	bin *binary.Service // adb/fastboot/scrcpy 路径探测
	dev *device.Service // 设备列表 + 激活 serial
}

// New 创建 service。cfgPath 是全局配置 config.yaml 路径，fragPath 是 fragments.yaml 路径。
// app 通过 SetApp 在 main 里注入（打破循环依赖）。
func New(reg *registry.Registry, wfReg *workflow.WorkflowRegistry, baseDir, cfgPath, fragPath string) *Service {
	g, _ := registry.LoadGlobal(cfgPath)
	if g == nil {
		g = map[string]string{}
	}
	frags, _ := registry.LoadFragments(fragPath)
	if frags == nil {
		frags = []registry.Fragment{}
	}
	if wfReg == nil {
		wfReg = &workflow.WorkflowRegistry{Workflows: map[string]workflow.LoadedWorkflow{}}
	}
	svc := &Service{
		reg:       reg,
		baseDir:   baseDir,
		cfgPath:   cfgPath,
		fragPath:  fragPath,
		global:    g,
		fragments: frags,
		running:   map[string]context.CancelFunc{},
		wfReg:     wfReg,
		wfRunning: map[string]context.CancelFunc{},
	}
	svc.bin = binary.NewService()
	svc.dev = device.NewService(svc.binPaths)
	return svc
}

// adbOverrides 返回 config.yaml 里的二进制路径覆盖（ADB_PATH/FASTBOOT_PATH/SCRCPY_PATH）。
func (s *Service) adbOverrides() map[string]string {
	s.gMu.Lock()
	defer s.gMu.Unlock()
	out := map[string]string{}
	for _, k := range []string{"ADB_PATH", "FASTBOOT_PATH", "SCRCPY_PATH"} {
		if v, ok := s.global[k]; ok {
			out[k] = v
		}
	}
	return out
}

// binPaths 解析当前三个二进制路径（config 覆盖 -> PATH -> 常见路径）。
func (s *Service) binPaths() binary.Paths {
	ov := s.adbOverrides()
	return s.bin.Paths(ov["ADB_PATH"], ov["FASTBOOT_PATH"], ov["SCRCPY_PATH"])
}

// newADBRunner 为指定动作构造 ADBRunner（按 command.adb.operation 分发）。
func (s *Service) newADBRunner(la registry.LoadedAction) *adb.ADBRunner {
	return &adb.ADBRunner{
		Bin:          s.bin,
		Dev:          s.dev,
		Operation:    la.Def.Command.Adb.Operation,
		Timeout:      la.Timeout,
		GetOverrides: s.adbOverrides,
	}
}

// newLLMRunner 为指定 LLM 动作构造 LLMRunner（CLI 名从 params/config 取，system/prompt 按 param id 取值）。
func (s *Service) newLLMRunner(la registry.LoadedAction, params map[string]any) *runner.LLMRunner {
	cli := strOf(params, "LLM_CLI")
	if cli == "" {
		cli = "ducc"
	}
	return &runner.LLMRunner{Cfg: runner.LLMConfig{
		CLI:          cli,
		SystemPrompt: strOf(params, la.Def.Command.LLM.System),
		Prompt:       strOf(params, la.Def.Command.LLM.Prompt),
		Cwd:          runner.Expand(la.Cwd, params),
		Timeout:      la.Timeout,
		Env:          la.Def.Command.Env,
	}}
}

// llmInfoOf 若动作是 LLM 形态则返回 LLMInfo 供前端布局，否则 nil。
func llmInfoOf(cmd registry.Command) *LLMInfo {
	if cmd.LLM.Prompt == "" {
		return nil
	}
	return &LLMInfo{SystemParam: cmd.LLM.System, PromptParam: cmd.LLM.Prompt}
}

// strOf 从 params map 安全取 string 值（key 空或缺失返回 ""）。
func strOf(params map[string]any, key string) string {
	if key == "" {
		return ""
	}
	v, ok := params[key]
	if !ok || v == nil {
		return ""
	}
	return fmt.Sprint(v)
}

// SetApp 注入 Wails app 引用（用于 emit 事件）。
func (s *Service) SetApp(app *application.App) { s.app = app }

// ActionItem 是前端可见的动作描述。
type ActionItem struct {
	ID          string               `json:"id"`
	Title       string               `json:"title"`
	Icon        string               `json:"icon"`
	Description string               `json:"description"`
	Params      []registry.ParamSpec `json:"params"`
	Presets     []registry.Preset    `json:"presets"`
	Stream      string               `json:"stream"`
	// LLM 非 nil 表示该动作是 command.llm 形态：前端据此走 LlmForm（system/prompt 主次布局）
	// + LlmView（流式回答视图）；nil 走通用 ParamForm。
	LLM *LLMInfo `json:"llm,omitempty"`
}

// LLMInfo 暴露给前端的 LLM 形态元信息：哪个 param 是 system、哪个是 prompt。
type LLMInfo struct {
	SystemParam string `json:"systemParam"`
	PromptParam string `json:"promptParam"`
}

// ListResult 包装 ListActions 的多返回值，便于前端绑定。
type ListResult struct {
	Actions []ActionItem `json:"actions"`
	Errors  []string     `json:"errors"`
}

// ListActions 返回全部已加载动作 + 加载错误。
func (s *Service) ListActions() ListResult {
	return s.buildListResult()
}

// buildListResult 从当前 registry 构造前端可见列表（ListActions 与 SetActionYaml 末尾共用）。
func (s *Service) buildListResult() ListResult {
	items := make([]ActionItem, 0, len(s.reg.Actions))
	for _, la := range s.reg.Actions {
		items = append(items, ActionItem{
			ID:          la.Def.ID,
			Title:       la.Def.Title,
			Icon:        la.Def.Icon,
			Description: la.Def.Description,
			Params:      la.Def.Params,
			Presets:     la.Def.Presets,
			Stream:      la.Def.Command.Stream,
			LLM:         llmInfoOf(la.Def.Command),
		})
	}
	errs := make([]string, 0, len(s.reg.Errors))
	for _, e := range s.reg.Errors {
		errs = append(errs, fmt.Sprintf("%s: %s", e.File, e.Error))
	}
	return ListResult{Actions: items, Errors: errs}
}

// Reload 重扫 actions 目录重建 registry（编辑保存后调用）。
// 低频操作：整体替换 reg 指针；正在运行的 action 持有旧 LoadedAction 副本，不受影响。
func (s *Service) Reload() {
	s.reg = registry.Load(filepath.Join(s.baseDir, "actions"), s.baseDir)
}

// GetActionYaml 返回指定 action 源文件原文（含注释与格式）。
func (s *Service) GetActionYaml(id string) (string, error) {
	la, ok := s.reg.Actions[id]
	if !ok {
		return "", fmt.Errorf("未知动作 %q", id)
	}
	data, err := os.ReadFile(la.File)
	if err != nil {
		return "", err
	}
	return string(data), nil
}

// SetActionYaml 校验并写回 action 源文件，随后重载 registry，返回最新列表。
// 禁止改 id（id 为文件锚点）；解析/校验失败时不写盘。
func (s *Service) SetActionYaml(id string, text string) (ListResult, error) {
	la, ok := s.reg.Actions[id]
	if !ok {
		return ListResult{}, fmt.Errorf("未知动作 %q", id)
	}
	def, err := registry.ParseAction([]byte(text))
	if err != nil {
		return ListResult{}, fmt.Errorf("YAML 解析失败: %w", err)
	}
	if def.ID != id {
		return ListResult{}, fmt.Errorf("id 不可修改（原 %q，现 %q）", id, def.ID)
	}
	if err := registry.Validate(def); err != nil {
		return ListResult{}, err
	}
	if err := os.WriteFile(la.File, []byte(text), 0644); err != nil {
		return ListResult{}, err
	}
	s.Reload()
	return s.buildListResult(), nil
}

// RunAction 按 id 启动动作，params 为运行时参数；输出通过事件流推送。
func (s *Service) RunAction(id string, params map[string]any) error {
	la, ok := s.reg.Actions[id]
	if !ok {
		return fmt.Errorf("未知动作 %q", id)
	}
	s.mu.Lock()
	if _, running := s.running[id]; running {
		s.mu.Unlock()
		return fmt.Errorf("动作 %q 正在运行", id)
	}
	ctx, cancel := context.WithCancel(context.Background())
	s.running[id] = cancel
	s.mu.Unlock()

	merged := s.mergeGlobalAndParams(params)
	go s.execute(ctx, id, la, merged)
	return nil
}

// mergeGlobalAndParams 合并全局配置与参数（参数覆盖同名全局），返回 runner 用的 vars。
func (s *Service) mergeGlobalAndParams(params map[string]any) map[string]any {
	// 先读激活 serial（dev 自己的锁），避免与 gMu 嵌套。
	activeSerial := ""
	if s.dev != nil {
		activeSerial = s.dev.ActiveSerial()
	}
	s.gMu.Lock()
	defer s.gMu.Unlock()
	out := make(map[string]any, len(s.global)+len(params))
	for k, v := range s.global {
		out[k] = v
	}
	for k, v := range params {
		out[k] = v // 参数优先
	}
	// 注入激活设备 serial 为 ${ADB_SERIAL}，让 shell action 与 adb action 共用同一设备来源。
	if activeSerial != "" {
		if _, ok := out["ADB_SERIAL"]; !ok {
			out["ADB_SERIAL"] = activeSerial
		}
	}
	return out
}

// CancelAction 取消正在运行的动作。
func (s *Service) CancelAction(id string) {
	s.mu.Lock()
	cancel, ok := s.running[id]
	s.mu.Unlock()
	if ok {
		cancel()
	}
}

// --- Device API（前端设备选择器）---

// DeviceListResult 包装设备列表与激活 serial。
type DeviceListResult struct {
	Devices []device.Summary `json:"devices"`
	Active  string           `json:"active"`
}

// ListDevices 返回当前 adb/fastboot 设备列表 + 激活 serial（无激活时自动选首个 ready）。
func (s *Service) ListDevices() (DeviceListResult, error) {
	devices, err := s.dev.ListDevices(context.Background())
	active := s.dev.ActiveSerial()
	if active == "" {
		active, _ = s.dev.ResolveActive(context.Background())
	}
	return DeviceListResult{Devices: devices, Active: active}, err
}

// GetDeviceInfo 返回单设备的详细信息。
func (s *Service) GetDeviceInfo(serial string) (*device.Info, error) {
	return s.dev.GetDeviceInfo(context.Background(), serial)
}

// SetActiveDevice 设置激活设备 serial（前端设备选择器调用）。
func (s *Service) SetActiveDevice(serial string) {
	s.dev.SetActive(serial)
}

// AddPreset 给指定动作新增/覆盖一个 preset（同名覆盖），写回 yaml 并重载，返回最新列表。
func (s *Service) AddPreset(actionID, name, description string, values map[string]string) (ListResult, error) {
	la, ok := s.reg.Actions[actionID]
	if !ok {
		return ListResult{}, fmt.Errorf("未知动作 %q", actionID)
	}
	raw, err := os.ReadFile(la.File)
	if err != nil {
		return ListResult{}, err
	}
	updated, err := registry.AddPresetToYAML(raw, name, description, values)
	if err != nil {
		return ListResult{}, err
	}
	if err := os.WriteFile(la.File, updated, 0644); err != nil {
		return ListResult{}, err
	}
	s.Reload()
	return s.buildListResult(), nil
}

// OpenActionsDir 用系统文件管理器打开 actions 目录（Windows: explorer / macOS: open / 其他: xdg-open）。
func (s *Service) OpenActionsDir() error {
	dir := filepath.Join(s.baseDir, "actions")
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "windows":
		cmd = exec.Command("explorer", dir)
	case "darwin":
		cmd = exec.Command("open", dir)
	default:
		cmd = exec.Command("xdg-open", dir)
	}
	return cmd.Start()
}

// GetGlobalConfig 返回当前全局配置（返回副本，避免前端误改内部 map）。
func (s *Service) GetGlobalConfig() map[string]string {
	s.gMu.Lock()
	defer s.gMu.Unlock()
	out := make(map[string]string, len(s.global))
	for k, v := range s.global {
		out[k] = v
	}
	return out
}

// SetGlobalConfig 替换全局配置并写回 config.yaml。
func (s *Service) SetGlobalConfig(kv map[string]string) error {
	s.gMu.Lock()
	defer s.gMu.Unlock()
	if err := registry.SaveGlobal(s.cfgPath, kv); err != nil {
		return err
	}
	s.global = kv
	return nil
}

// GetFragments 返回当前指令片段列表（副本）。
func (s *Service) GetFragments() []registry.Fragment {
	s.fMu.Lock()
	defer s.fMu.Unlock()
	out := make([]registry.Fragment, len(s.fragments))
	copy(out, s.fragments)
	return out
}

// SetFragments 替换指令片段并写回 fragments.yaml。
func (s *Service) SetFragments(list []registry.Fragment) error {
	s.fMu.Lock()
	defer s.fMu.Unlock()
	if err := registry.SaveFragments(s.fragPath, list); err != nil {
		return err
	}
	s.fragments = list
	return nil
}

// varRefRe 匹配变量引用：${VAR}（runner.Expand / sh）或 $env:VAR（PowerShell）。
var varRefRe = regexp.MustCompile(`\$\{([A-Za-z0-9_]+)\}|\$env:([A-Za-z0-9_]+)`)

// GetVarReferenceCounts 统计每个变量被多少处引用：
// 所有 action 的 shell 命令 + script 脚本文件内容 + 指令片段。
// 同一处（一个 action 或一个片段）内重复引用只计一次，体现「是否被用到」。
func (s *Service) GetVarReferenceCounts() map[string]int {
	counts := make(map[string]int)
	add := func(text string) {
		seen := make(map[string]bool)
		for _, m := range varRefRe.FindAllStringSubmatch(text, -1) {
			name := m[1]
			if name == "" {
				name = m[2] // $env:VAR 分支
			}
			if !seen[name] {
				seen[name] = true
				counts[name]++
			}
		}
	}
	// actions：inline shell + cwd + env values + script 脚本文件内容
	for _, la := range s.reg.Actions {
		add(la.Def.Command.Shell)
		add(la.Def.Command.Cwd)
		for _, v := range la.Def.Command.Env {
			add(v)
		}
		if la.Def.Command.Script != "" {
			if data, ok := readScriptBytes(la.Def.Command.Script, s.baseDir); ok {
				add(string(data))
			}
		}
	}
	// workflows：workflow 级 env + 每个 step 的 shell / params / env 值
	// （运行时这些字段都会被 runner.Expand 展开 ${VAR}，故都需统计引用）
	s.wfMu.Lock()
	for _, lw := range s.wfReg.Workflows {
		for _, v := range lw.Def.Env {
			add(v)
		}
		for _, step := range lw.Def.Steps {
			add(step.Shell)
			for _, v := range step.Params {
				add(v)
			}
			for _, v := range step.Env {
				add(v)
			}
		}
	}
	s.wfMu.Unlock()
	// fragments
	s.fMu.Lock()
	for _, f := range s.fragments {
		add(f.Content)
	}
	s.fMu.Unlock()
	return counts
}

// readScriptBytes 读取 script 脚本内容（.sh 与 .ps1 都读并合并），相对路径基于 baseDir。
// 两份都读是为了与运行平台解耦——统计的是「变量名是否被引用」，与实际执行哪个脚本无关。
// 两个后缀都读不到（路径含变量、文件缺失）则返回 false。
func readScriptBytes(script, baseDir string) ([]byte, bool) {
	p := script
	if !filepath.IsAbs(p) {
		p = filepath.Join(baseDir, p)
	}
	var data []byte
	found := false
	for _, ext := range []string{".sh", ".ps1"} {
		if d, err := os.ReadFile(p + ext); err == nil {
			data = append(data, d...)
			found = true
		}
	}
	return data, found
}

func (s *Service) execute(ctx context.Context, id string, la registry.LoadedAction, params map[string]any) {
	// 统一在进入 runner 前对 params 做 ${VAR} 展开：runner 拿到的是终值，不再各自展开。
	params = runner.ExpandParams(params)
	defer func() {
		s.mu.Lock()
		delete(s.running, id)
		s.mu.Unlock()
	}()

	// Wails 的 Event.Emit 每次调用都各自起一个 goroutine 投递（同 executeWorkflow 的
	// curStep 备注），事件到达前端的顺序无保证。workflow 靠 step 索引分桶规避；
	// action 是单一输出桶，用自增 seq 让前端按到达后排序还原真实产出顺序。
	// seq 由 emitDone 接续使用（退出码行必须排在所有 output 行之后，同一序号空间才能保证）。
	var seq int64
	emit := func(stream, line string) {
		seq++
		s.app.Event.Emit(eventName(id, "output"), map[string]any{
			"stream": stream, "line": line, "seq": seq,
		})
	}

	// 运行时替换 cwd（用 merged params），替换后检查存在性
	cwd := runner.Expand(la.Cwd, params)
	if cwd != "" {
		if _, err := os.Stat(cwd); err != nil {
			s.emitDone(id, -1, fmt.Sprintf("工作目录不存在: %s", cwd), 0, nil)
			return
		}
	}

	shellCfg := runner.ShellConfig{
		Shell:   la.Def.Command.Shell,
		Script:  la.Def.Command.Script,
		Cwd:     la.Cwd, // raw，由 runner 用 params 替换
		Timeout: la.Timeout,
		Env:     la.Def.Command.Env,
		BaseDir: s.baseDir,
	}
	var r runner.Runner
	switch {
	case la.Def.Command.Adb.Operation != "":
		r = s.newADBRunner(la)
	case la.Def.Command.LLM.Prompt != "":
		r = s.newLLMRunner(la, params)
	default:
		r = &runner.ShellRunner{Cfg: shellCfg}
	}

	res := r.Run(ctx, params, emit)
	// LLM 动作附会话读数（聊天页终点读数行）：cost/tokens 来自 stream-json 的 result 事件
	// （runner.recordStructuredFields 写入 Outputs），duration 用后端精确计时
	var readout map[string]any
	if la.Def.Command.LLM.Prompt != "" {
		readout = llmReadout(res.Outputs, res.Duration)
	}
	// done 事件延续 output 的 seq 序号空间（seq+1）：done 事件也走独立 goroutine 投递，
	// 前端若不按序号排它可能抢跑在还没到达的 output 行前面，把退出码行插错位置。
	s.emitDoneSeq(id, res.ExitCode, errStr(res.Err), res.Duration, readout, seq+1)
}

func (s *Service) emitDone(id string, exitCode int, errMsg string, d time.Duration, readout map[string]any) {
	s.emitDoneSeq(id, exitCode, errMsg, d, readout, 0)
}

// emitDoneSeq 同 emitDone，附带 seq（output 事件序号空间的延续值）。
// 前端要在应用完所有 seq 小于它的 output 行之后才能落地退出码行，否则 done 事件
// 抢跑在还没到达的 output 前面会把退出码行插到中间。seq=0（无序号场景，如 execute
// 早退的工作目录校验失败）表示不参与排序，前端直接应用。
func (s *Service) emitDoneSeq(id string, exitCode int, errMsg string, d time.Duration, readout map[string]any, seq int64) {
	payload := map[string]any{
		"exitCode": exitCode,
		"err":      errMsg,
		"duration": d.String(),
	}
	if readout != nil {
		payload["readout"] = readout
	}
	if seq > 0 {
		payload["seq"] = seq
	}
	s.app.Event.Emit(eventName(id, "done"), payload)
}

// llmReadout 从 LLM Result.Outputs 挑出终点读数字段（数值化）；无可读字段时返回 nil。
func llmReadout(outputs map[string]string, d time.Duration) map[string]any {
	r := map[string]any{"durationMs": d.Milliseconds()}
	if v, err := strconv.ParseFloat(outputs["cost_usd"], 64); err == nil {
		r["costUsd"] = v
	}
	in, errIn := strconv.Atoi(outputs["input_tokens"])
	out, errOut := strconv.Atoi(outputs["output_tokens"])
	if errIn == nil && errOut == nil {
		r["inputTokens"] = in
		r["outputTokens"] = out
	}
	if _, ok := r["costUsd"]; !ok {
		if _, ok := r["inputTokens"]; !ok {
			return nil
		}
	}
	return r
}

func eventName(id, suffix string) string {
	return fmt.Sprintf("action:%s:%s", id, suffix)
}

func errStr(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}

// --- Workflow API ---

// WorkflowStepInfo 是前端侧边栏/概览可见的步骤摘要。
type WorkflowStepInfo struct {
	Kind  string `json:"kind"`  // "action" | "sleep" | "shell"
	Label string `json:"label"` // 显示文案，如 action id / "5s" / 截断 shell
	Name  string `json:"name"`  // step.name 人类可读标签（可为空）
}

// WorkflowItem 是前端可见的 workflow 描述。
type WorkflowItem struct {
	ID          string               `json:"id"`
	Title       string               `json:"title"`
	Icon        string               `json:"icon"`
	Description string               `json:"description"`
	StepCount   int                  `json:"stepCount"`
	Params      []registry.ParamSpec `json:"params"`
	Steps       []WorkflowStepInfo   `json:"steps"`
}

// WorkflowListResult 是 ListWorkflows 的返回值。
type WorkflowListResult struct {
	Workflows []WorkflowItem `json:"workflows"`
	Errors    []string       `json:"errors"`
}

// ListWorkflows 返回全部已加载 workflow + 加载错误。
func (s *Service) ListWorkflows() WorkflowListResult {
	items := make([]WorkflowItem, 0, len(s.wfReg.Workflows))
	for _, lw := range s.wfReg.Workflows {
		steps := buildStepInfos(lw.Def.Steps)
		items = append(items, WorkflowItem{
			ID:          lw.Def.ID,
			Title:       lw.Def.Title,
			Icon:        lw.Def.Icon,
			Description: lw.Def.Description,
			StepCount:   len(lw.Def.Steps),
			Params:      lw.Def.Params,
			Steps:       steps,
		})
	}
	errs := make([]string, 0, len(s.wfReg.Errors))
	for _, e := range s.wfReg.Errors {
		errs = append(errs, fmt.Sprintf("%s: %s", e.File, e.Error))
	}
	return WorkflowListResult{Workflows: items, Errors: errs}
}

// buildStepInfos 把 step 列表转换为前端可用的摘要。
func buildStepInfos(steps []workflow.Step) []WorkflowStepInfo {
	infos := make([]WorkflowStepInfo, len(steps))
	for i, s := range steps {
		info := WorkflowStepInfo{Name: s.Name}
		switch {
		case s.Action != "":
			info.Kind = "action"
			info.Label = s.Action
		case s.Sleep > 0:
			info.Kind = "sleep"
			info.Label = fmt.Sprintf("%ds", s.Sleep)
		case s.Shell != "":
			label := s.Shell
			if len(label) > 40 {
				label = label[:37] + "..."
			}
			info.Kind = "shell"
			info.Label = label
		}
		infos[i] = info
	}
	return infos
}

// ReloadWorkflows 重扫 workflows 目录重建 wfReg（编辑保存后调用）。
func (s *Service) ReloadWorkflows() {
	s.wfReg = workflow.Load(filepath.Join(s.baseDir, "workflows"))
}

// GetWorkflowYaml 返回指定 workflow 源文件原文（含注释与格式）。
func (s *Service) GetWorkflowYaml(id string) (string, error) {
	lw, ok := s.wfReg.Workflows[id]
	if !ok {
		return "", fmt.Errorf("未知 workflow %q", id)
	}
	data, err := os.ReadFile(lw.File)
	if err != nil {
		return "", err
	}
	return string(data), nil
}

// SetWorkflowYaml 校验并写回 workflow 源文件，随后重载 wfReg，返回最新列表。
// 禁止改 id（id 为文件锚点）；解析/校验失败时不写盘。
func (s *Service) SetWorkflowYaml(id string, text string) (WorkflowListResult, error) {
	lw, ok := s.wfReg.Workflows[id]
	if !ok {
		return WorkflowListResult{}, fmt.Errorf("未知 workflow %q", id)
	}
	def, err := workflow.ParseWorkflow([]byte(text))
	if err != nil {
		return WorkflowListResult{}, fmt.Errorf("YAML 解析失败: %w", err)
	}
	if def.ID != id {
		return WorkflowListResult{}, fmt.Errorf("id 不可修改（原 %q，现 %q）", id, def.ID)
	}
	if err := workflow.Validate(def); err != nil {
		return WorkflowListResult{}, err
	}
	if err := os.WriteFile(lw.File, []byte(text), 0644); err != nil {
		return WorkflowListResult{}, err
	}
	s.ReloadWorkflows()
	return s.ListWorkflows(), nil
}

// RunWorkflow 启动 workflow 执行；同一 workflow 并发运行被拒。
func (s *Service) RunWorkflow(id string, params map[string]any) error {
	lw, ok := s.wfReg.Workflows[id]
	if !ok {
		return fmt.Errorf("未知 workflow %q", id)
	}
	s.wfMu.Lock()
	if _, running := s.wfRunning[id]; running {
		s.wfMu.Unlock()
		return fmt.Errorf("workflow %q 正在运行", id)
	}
	ctx, cancel := context.WithCancel(context.Background())
	s.wfRunning[id] = cancel
	s.wfMu.Unlock()

	go s.executeWorkflow(ctx, id, lw, params)
	return nil
}

// CancelWorkflow 取消正在运行的 workflow。
func (s *Service) CancelWorkflow(id string) {
	s.wfMu.Lock()
	cancel, ok := s.wfRunning[id]
	s.wfMu.Unlock()
	if ok {
		cancel()
	}
}

// executeWorkflow 在 goroutine 中运行 workflow，输出通过事件流推送。
func (s *Service) executeWorkflow(ctx context.Context, id string, lw workflow.LoadedWorkflow, params map[string]any) {
	defer func() {
		s.wfMu.Lock()
		delete(s.wfRunning, id)
		s.wfMu.Unlock()
	}()

	// curStep 记录当前正在执行的 step 索引，随每条 output 事件下发。
	// 必要性：Wails 的 Event.Emit 每次都起独立 goroutine 投递（application/events.go），
	// 事件到达前端的顺序无保证——push 末尾的 100% progress 会与 step-done/下一个
	// step-start 抢跑，输了就被前端折进下一个 step 的输出里。带上 step 归属后，
	// 前端按索引落桶，与到达顺序无关。
	// 并发安全：写发生在 executor goroutine 的 step 边界，读发生在 runner 的
	// 输出 goroutine；runner.Run 返回前已 join 全部输出 goroutine，故两者有序不重叠。
	curStep := ""
	emit := func(stream, line string) {
		if stream == "step-start" || stream == "step-skip" {
			curStep = line
		}
		s.app.Event.Emit(workflowEventName(id, "output"), map[string]string{
			"stream": stream, "line": line, "step": curStep,
		})
	}

	merged := s.mergeGlobalAndParams(params)
	actionRun := s.makeActionRun(ctx, merged)
	shellRun := s.makeShellRun(ctx, merged)

	res := (&workflow.Executor{}).Execute(ctx, lw, actionRun, shellRun, merged, emit)

	s.app.Event.Emit(workflowEventName(id, "done"), map[string]any{
		"exitCode": res.ExitCode,
		"err":      errStr(res.Err),
		"duration": res.Duration.String(),
	})
}

// makeActionRun 构造 workflow 中 action step 的执行回调。
// merged 是 global+workflow params 合并结果（终值），作为 step.params/env 里 ${VAR} 的变量源。
func (s *Service) makeActionRun(ctx context.Context, merged map[string]any) workflow.ActionRunFunc {
	return func(actionID string, stepParams map[string]any, env map[string]string, captureOutput *bool, stepEmit runner.EmitFunc) runner.Result {
		la, ok := s.reg.Actions[actionID]
		if !ok {
			stepEmit("stderr", fmt.Sprintf("未知动作 %q", actionID))
			return runner.Result{ExitCode: -1, Err: fmt.Errorf("未知动作 %q", actionID)}
		}
		// ${VAR} 展开必须在合并前完成（详见 buildActionRunParams 注释）。
		runParams, expandedEnv := buildActionRunParams(merged, env, stepParams)
		// env 分层：action 定义的 env + workflow/step 注入的 env（后者覆盖前者）
		mergedEnv := make(map[string]string, len(la.Def.Command.Env)+len(expandedEnv))
		for k, v := range la.Def.Command.Env {
			mergedEnv[k] = v
		}
		for k, v := range expandedEnv {
			mergedEnv[k] = v
		}
		// captureOutput 优先级：step 显式设置 > action 定义
		capture := la.Def.Command.CaptureOutput
		if captureOutput != nil {
			capture = captureOutput
		}
		shellCfg := runner.ShellConfig{
			Shell:         la.Def.Command.Shell,
			Script:        la.Def.Command.Script,
			Cwd:           la.Cwd,
			Timeout:       la.Timeout,
			Env:           mergedEnv,
			BaseDir:       s.baseDir,
			CaptureOutput: capture,
		}
		var r runner.Runner
		switch {
		case la.Def.Command.Adb.Operation != "":
			r = s.newADBRunner(la)
		case la.Def.Command.LLM.Prompt != "":
			r = s.newLLMRunner(la, runParams)
		default:
			r = &runner.ShellRunner{Cfg: shellCfg}
		}
		return r.Run(ctx, runParams, stepEmit)
	}
}

// makeShellRun 构造 workflow 中 inline shell step 的执行回调。timeout 缺省 60s。
func (s *Service) makeShellRun(ctx context.Context, merged map[string]any) workflow.ShellRunFunc {
	return func(shellCmd, timeoutStr string, env map[string]string, captureOutput *bool, params map[string]any, stepEmit runner.EmitFunc) runner.Result {
		timeout := 60 * time.Second
		if timeoutStr != "" {
			if d, err := time.ParseDuration(timeoutStr); err == nil {
				timeout = d
			}
		}
		// env 的 ${VAR} 用 merged 展开（合并前），避免与 merged 同名键自引用。
		expandedEnv := runner.ExpandMap(env, merged)
		// 合并 merged params + 已展开 env + 传入 params（=stepCtx.Params，即 merged），优先级从低到高
		runParams := make(map[string]any, len(merged)+len(expandedEnv)+len(params))
		for k, v := range merged {
			runParams[k] = v
		}
		for k, v := range expandedEnv {
			runParams[k] = v
		}
		for k, v := range params {
			runParams[k] = v
		}
		r := &runner.ShellRunner{Cfg: runner.ShellConfig{
			Shell:         shellCmd,
			Timeout:       timeout,
			Env:           expandedEnv,
			BaseDir:       s.baseDir,
			CaptureOutput: captureOutput,
		}}
		return r.Run(ctx, runParams, stepEmit)
	}
}

// buildActionRunParams 构造 action step 的 runParams：以 merged 为变量源展开 env 与 step.params，再合并。
// 必须在合并前展开：step.params 常含 { PACKAGE: "${PACKAGE}" }，若先把字面量合并进 runParams
// 再展开，会覆盖 merged 的真实值并形成自引用（${PACKAGE} 查表查到自身），原样保留 → 设备端收到空包名。
// 返回终值 runParams 与已展开的 env（供 ShellRunner 的 cfg.Env 使用）。
func buildActionRunParams(merged map[string]any, env map[string]string, stepParams map[string]any) (map[string]any, map[string]string) {
	expandedEnv := runner.ExpandMap(env, merged)
	runParams := make(map[string]any, len(merged)+len(expandedEnv)+len(stepParams))
	for k, v := range merged {
		runParams[k] = v
	}
	for k, v := range expandedEnv {
		runParams[k] = v
	}
	for k, v := range stepParams {
		if sv, ok := v.(string); ok {
			runParams[k] = runner.Expand(sv, merged)
		} else {
			runParams[k] = v
		}
	}
	return runParams, expandedEnv
}

func workflowEventName(id, suffix string) string {
	return fmt.Sprintf("workflow:%s:%s", id, suffix)
}
