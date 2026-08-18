package logcat

// stream.go 是 logcat-stream operation 的实现：raw ring + 统一规则求值 + 运行期
// 规则更新与重放（spec: docs/superpowers/specs/2026-08-18-logcat-filter-chips-design.md）。
//
// 数据流：adb logcat -T 1 -v threadtime 逐行 → parseEntry → 先入 10k raw ring
// （无论是否通过——重放需要全量历史）→ 求值（CompiledRule + 包名 pid 集）→ 通过则
// 进增量缓冲，ticker 每 ~100ms 以 stream="logcat" 批量下发。
//
// 运行期更新（api.UpdateLogcatFilter 经 OpContext.Control 送达 FilterUpdate）：
// 换编译后规则 →（包名变化时重启 pid 解析）→ 重筛整个 ring → 以 stream="logcat-replace"
// 分 chunk 整体重发（首帧 head=true 携带 matched/total 与 top-200 tag 直方图，
// 前端收到首帧即清空替换）；reset=true 时 ring 与增量缓冲同清（清空按钮联动）。

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"sync"
	"time"

	"workflow-tool/internal/adb"
	"workflow-tool/internal/adbcore"
)

// OpStream 是流式 logcat operation 名（api 层按此识别可运行期控制的动作）。
const OpStream = "logcat-stream"

const (
	// ringCap raw ring 容量：重放可找回的历史窗口（spec 决策 6）。
	ringCap = 10000
	// flushInterval / maxBatch 增量帧聚合节奏：逐行只压缓冲，ticker 每 ~100ms 批量
	// 序列化下发；单次 emit 超上限拆 chunk，分摊首次倾倒峰值（事件数从万级降到 ~10/s）。
	flushInterval = 100 * time.Millisecond
	maxBatch      = 500
	// replaceChunk replace 帧 entries 分块上限，对齐增量帧的 maxBatch。
	replaceChunk = 500
	// histogramTop replace 帧附带的 tag 直方图上限（补全层/快捷条数据源）。
	histogramTop = 200
)

// FilterUpdate 是 api → logcat-stream 的运行期过滤更新消息（经 OpContext.Control）。
// Rule 为整体快照（非增量）；Reset=true 先清空 raw ring 与增量缓冲再按新规则重放。
type FilterUpdate struct {
	Rule  Rule `json:"rule"`
	Reset bool `json:"reset"`
}

// handleStream 前台流式 logcat。取消/超时视为正常结束（ExitCode 0）。
func handleStream(op *adb.OpContext) adb.OpResult {
	// 初始规则：FILTER 参数（甲板存为预设的完整规则 JSON）优先，legacy 参数兜底
	//（RuleFromParamsExt 宽松，产物必可编译；FILTER 携带非法规则时由下方 CompileRule 硬失败）。
	rule := RuleFromParamsExt(op.ParamStr("LEVEL"), op.ParamStr("TAG"),
		op.ParamStr("INCLUDE"), op.ParamStr("EXCLUDE"), op.ParamStr("PACKAGE"), op.ParamStr(ParamFilter))
	cr, err := CompileRule(rule)
	if err != nil {
		// 走到这里说明映射器与编译器语义漂移（编程错误），硬失败尽早暴露。
		opErr := adbcore.NewOperationError(OpStream, "invalid initial filter rule", err.Error(), false)
		op.EmitStderr(opErr.Error())
		return adb.OpResult{ExitCode: 2, Err: opErr, Stderr: opErr.Error()}
	}

	// streamDone 在 RunStreaming 返回后关闭（任意原因：取消/超时/进程退出）。
	// ctx 只覆盖取消/超时；adb 进程自然退出（设备拔出等）时 ctx 仍存活，伴随协程
	// 不能只等 ctx.Done——否则流意外断开后 handler 卡在等待协程退出。
	streamDone := make(chan struct{})

	core := &streamCore{ring: newRing(ringCap), rule: cr}
	refresher := &pidRefresher{op: op, done: streamDone}

	// 聚合 emit：逐行只压入缓冲，ticker 每 ~100ms 批量下发。logcat 突发时若逐行
	// op.Emit，事件风暴会压垮前端 IPC；批量化后事件数降到 ~10/s。emit 在 core.mu
	// 锁内进行（见 streamCore 注释），超上限拆多个 chunk 顺序下发。
	flush := func() {
		core.mu.Lock()
		defer core.mu.Unlock()
		if len(core.buf) == 0 {
			return
		}
		batch := core.buf
		core.buf = nil
		for len(batch) > 0 {
			n := len(batch)
			if n > maxBatch {
				n = maxBatch
			}
			if payload, mErr := json.Marshal(batch[:n]); mErr == nil {
				op.Emit("logcat", string(payload))
			}
			batch = batch[n:]
		}
	}
	flushDone := make(chan struct{})
	go func() {
		ticker := time.NewTicker(flushInterval)
		defer func() {
			ticker.Stop()
			flush() // 收尾 flush 保证不丢条目
			close(flushDone)
		}()
		for {
			select {
			case <-ticker.C:
				flush()
			case <-op.Ctx.Done():
				return
			case <-streamDone:
				return
			}
		}
	}()

	// 初始包过滤（含首解告警）：包运行前 pid 集为空 = 不匹配任何行，app 起来后自动跟上。
	refresher.start(op.ParamStr("PACKAGE"))

	onLine := func(stream, line string) {
		e := parseEntry(line)
		pids := refresher.current() // 不可变快照引用，锁外持有安全（见 pidRefresher）
		core.mu.Lock()
		core.ring.push(e) // raw ring 先进：重放需全量历史（放宽条件可找回）
		if allowEntry(core.rule, pids, &e) {
			core.buf = append(core.buf, entryJSON(e))
		}
		core.mu.Unlock()
	}

	// 控制循环：FilterUpdate → 换规则 + 重筛 ring + 重放（applyUpdate）。
	if op.Control != nil {
		go func() {
			for {
				select {
				case <-op.Ctx.Done():
					return
				case <-streamDone:
					return
				case u := <-op.Control:
					fu, ok := u.(FilterUpdate)
					if !ok {
						continue // 未知消息：防御性忽略（发送侧只有 api.UpdateLogcatFilter）
					}
					applyUpdate(op, core, refresher, fu)
				}
			}
		}()
	}

	// -T 1：从最新一行开始流式（last + follow），避免连接瞬间倾倒整个设备缓冲。
	req := op.AdbStream(false, onLine, "logcat", "-T", "1", "-v", "threadtime")
	res, err := adbcore.RunStreaming(op.Ctx, req)
	// RunStreaming 返回时扫描协程已退出（onLine 不再触发），唤醒伴随协程并等待收尾 flush。
	close(streamDone)
	<-flushDone
	switch {
	case err == nil:
		op.EmitStdout(fmt.Sprintf("logcat stream ended (exit %d)", res.ExitCode))
		if res.ExitCode != 0 {
			opErr := adbcore.NewOperationError(OpStream, "logcat exited with non-zero status", res.Stderr, false)
			return adb.OpResult{ExitCode: res.ExitCode, Stderr: res.Stderr, Err: opErr}
		}
		return adb.OpResult{ExitCode: 0}
	case errors.Is(err, context.Canceled), errors.Is(err, context.DeadlineExceeded):
		// 取消/超时是前台流的预期终止方式。
		op.EmitStdout("logcat stream stopped")
		return adb.OpResult{ExitCode: 0}
	default:
		exitCode := -1
		stderr := err.Error()
		if res != nil {
			exitCode = res.ExitCode
			if res.Stderr != "" {
				stderr = res.Stderr
			}
		}
		op.EmitStderr(stderr)
		opErr := adbcore.NewOperationError(OpStream, "logcat stream failed", stderr, false)
		return adb.OpResult{ExitCode: exitCode, Err: opErr, Stderr: stderr}
	}
}

// applyUpdate 应用一次运行期过滤更新：编译 →（包名变化时重启 pid 解析，阻塞至新包
// 首解完成，重放即用新 pid 集）→ core.mu 内换规则、清增量缓冲、重筛 ring 快照、
// replace 帧整体重发。API 侧已同步校验过规则；此处防御性拒绝非法规则并沿用旧规则
// （spec 错误处理：不静默降级）。
func applyUpdate(op *adb.OpContext, core *streamCore, refresher *pidRefresher, fu FilterUpdate) {
	cr, err := CompileRule(fu.Rule)
	if err != nil {
		op.EmitStderr("warning: rejected filter update (" + err.Error() + "); keeping previous rule")
		return
	}
	if refresher.pkgName() != fu.Rule.Package {
		refresher.start(fu.Rule.Package)
	}
	pids := refresher.current()
	core.mu.Lock()
	defer core.mu.Unlock()
	if fu.Reset {
		core.ring.clear()
	}
	core.rule = cr
	// 快照前的增量缓冲作废：其中每行都已入 ring，将由 replace 帧重新裁决，
	// 这与快照+换规则在同一临界段内完成，保证对前端不重不漏。
	core.buf = nil
	for _, f := range buildReplaceFrames(core.ring.snapshot(), cr, pids) {
		if payload, mErr := json.Marshal(f); mErr == nil {
			op.Emit("logcat-replace", string(payload))
		}
	}
}

// streamCore 是 handleStream 的共享内核。ring/规则/增量缓冲均由 mu 保护，且所有
// op.Emit（增量与 replace）都在锁内进行：drain+emit 与 swap+快照+清缓冲+emit 都是
// 原子段，两类帧对前端全局有序——快照前的行只经 replace 呈现，快照后的行只走增量帧。
type streamCore struct {
	mu   sync.Mutex
	ring *ring
	rule *CompiledRule // nil 视为全通过（Allow 契约）
	buf  []logcatPayload
}

// allowEntry 统一求值入口：包名 pid 集先行（nil=无包过滤全量；空集=包未运行全排除），
// 再过编译规则。
func allowEntry(cr *CompiledRule, pids map[int]struct{}, e *Entry) bool {
	if pids != nil {
		if _, ok := pids[e.Pid]; !ok {
			return false
		}
	}
	return cr.Allow(e)
}

// ring 是固定容量环形缓冲（先入后筛：存全量解析后条目，重放时整体重筛）。
type ring struct {
	buf  []Entry
	head int // 下一写入位
	full bool
}

func newRing(capacity int) *ring { return &ring{buf: make([]Entry, capacity)} }

func (r *ring) push(e Entry) {
	r.buf[r.head] = e
	r.head++
	if r.head == len(r.buf) {
		r.head = 0
		r.full = true // 首次绕回即写满全部槽位
	}
}

func (r *ring) len() int {
	if r.full {
		return len(r.buf)
	}
	return r.head
}

// clear 清空缓冲（同时清引用，尽早释放 10k 条 Entry 持有的字符串）。
func (r *ring) clear() {
	for i := range r.buf {
		r.buf[i] = Entry{}
	}
	r.head, r.full = 0, false
}

// snapshot 按时间序（最旧→最新）返回 ring 内容副本。
func (r *ring) snapshot() []Entry {
	n := r.len()
	out := make([]Entry, 0, n)
	if r.full { // head 指向最旧条目
		out = append(out, r.buf[r.head:]...)
		out = append(out, r.buf[:r.head]...)
	} else {
		out = append(out, r.buf[:n]...)
	}
	return out
}

// replaceFrame 是 stream="logcat-replace" 的下发帧。首帧 head=true：前端清空本地
// 缓冲、整体替换，并从帧读取 matched/total 与 tag 直方图；后续 chunk 只带 entries。
type replaceFrame struct {
	Head         bool            `json:"head"`
	Entries      []logcatPayload `json:"entries"`
	Matched      int             `json:"matched,omitempty"`
	Total        int             `json:"total,omitempty"`
	TagHistogram map[string]int  `json:"tagHistogram,omitempty"`
}

// buildReplaceFrames 重筛快照并切分 replace 帧（纯函数，供单测）。
// matched/total 与直方图都基于本次重筛结果；直方图取 top-200（频次降序、并列按
// tag 字典序，确定性输出），是前端补全层与快捷条的数据源。
func buildReplaceFrames(snap []Entry, cr *CompiledRule, pids map[int]struct{}) []replaceFrame {
	matched := make([]logcatPayload, 0, len(snap)/8)
	hist := map[string]int{}
	for i := range snap {
		if !allowEntry(cr, pids, &snap[i]) {
			continue
		}
		matched = append(matched, entryJSON(snap[i]))
		if snap[i].Tag != "" {
			hist[snap[i].Tag]++
		}
	}
	top := topTags(hist, histogramTop)
	var frames []replaceFrame
	for start := 0; ; start += replaceChunk {
		end := start + replaceChunk
		if end > len(matched) {
			end = len(matched)
		}
		f := replaceFrame{Entries: matched[start:end]}
		if start == 0 {
			f.Head = true
			f.Matched = len(matched)
			f.Total = len(snap)
			f.TagHistogram = top
		}
		frames = append(frames, f)
		if end >= len(matched) {
			return frames
		}
	}
}

// topTags 取频次 top-n 的 tag（并列按 tag 字典序）。
func topTags(hist map[string]int, n int) map[string]int {
	if len(hist) <= n {
		return hist
	}
	type kv struct {
		k string
		v int
	}
	arr := make([]kv, 0, len(hist))
	for k, v := range hist {
		arr = append(arr, kv{k, v})
	}
	sort.Slice(arr, func(i, j int) bool {
		if arr[i].v != arr[j].v {
			return arr[i].v > arr[j].v
		}
		return arr[i].k < arr[j].k
	})
	out := make(map[string]int, n)
	for _, e := range arr[:n] {
		out[e.k] = e.v
	}
	return out
}

// pidRefresher 包名 → pid 集周期解析（5s ticker），支持运行期换包重启。
// pids 语义：nil=无包过滤（全量）；空 map=包未运行（全排除，pidof 命中后自动跟上）。
// 更新协程只整体替换 pids map、绝不原地修改，读者拿到引用后锁外持有安全。
// gen 代数防止竞态落地：连续换包时，只有最新一代的解析结果与刷新协程生效。
type pidRefresher struct {
	op   *adb.OpContext
	done <-chan struct{} // streamDone：流结束后刷新协程退出
	mu   sync.RWMutex
	pids map[int]struct{}
	pkg  string
	gen  uint64
	stop chan struct{} // 当前刷新协程的停止信号；nil=无协程
}

// pkgName 返回当前包名（"" = 无包过滤）。
func (p *pidRefresher) pkgName() string {
	p.mu.RLock()
	defer p.mu.RUnlock()
	return p.pkg
}

// current 返回当前 pid 集（不可变快照引用）。
func (p *pidRefresher) current() map[int]struct{} {
	p.mu.RLock()
	defer p.mu.RUnlock()
	return p.pids
}

// start 切换到 pkg（"" 停止包过滤）：登记新一代后先阻塞解析首版 pid 集（锁外执行
// adb，不挡 onLine 读），再原子落地并启动 5s 周期刷新；包未运行时告警并周期重试。
func (p *pidRefresher) start(pkg string) {
	p.mu.Lock()
	p.gen++
	myGen := p.gen
	p.pkg = pkg
	if p.stop != nil {
		close(p.stop)
		p.stop = nil
	}
	p.mu.Unlock()

	if pkg == "" {
		p.mu.Lock()
		defer p.mu.Unlock()
		if p.gen == myGen {
			p.pids = nil
		}
		return
	}
	np := resolvePids(p.op, pkg)
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.gen != myGen {
		return // 已被更新的 start 取代，结果作废
	}
	p.pids = np
	if len(np) == 0 {
		p.op.EmitStderr("warning: no running process found for package " + pkg + "; will retry every 5s")
	}
	stop := make(chan struct{})
	p.stop = stop
	go p.loop(pkg, myGen, stop)
}

// loop 每 5s 重解析 pid 集；被新一代 start 取代（gen 不符/stop 关闭）或流结束时退出。
func (p *pidRefresher) loop(pkg string, myGen uint64, stop chan struct{}) {
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ticker.C:
			np := resolvePids(p.op, pkg)
			p.mu.Lock()
			if p.gen == myGen {
				p.pids = np
			}
			p.mu.Unlock()
		case <-stop:
			return
		case <-p.done:
			return
		case <-p.op.Ctx.Done():
			return
		}
	}
}
