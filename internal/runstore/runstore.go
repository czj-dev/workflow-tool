// Package runstore 是运行记录：每次运行不论来源都留下一条结论性事实与一份运行日志。
//
// 落盘位置是可执行文件同级的 runs/<run-id>/，不入仓库：
//
//	run.json       运行记录本体。启动时写一次（running），结束时写一次终态——
//	               任何路径不得二次改写终态。执行器运行另在运行期间回写心跳。
//	events.ndjson  运行日志：该次运行 output 事件的逐行落盘，与前端收到的事件
//	               同构（每行另带相对启动时刻的毫秒偏移 t），运行详情用它回放。
//	STOP           停止标记：应用写入，执行器轮询到即取消（仅执行器运行会有）。
//
// run-id 由启动时刻（到秒）与随机后缀组成，目录名即 id。
//
// 调度到点与立即运行交给独立执行器（同一可执行文件的 run 子命令）：应用建好记录后把
// 进程拉起来，执行器经 Attach 接手这条记录——写进程信息与心跳、续写日志、落终态。
// 应用启动时按心跳与进程身份认领仍在运行的执行器；确认不在的改写为中断。
//
// 保留策略：每个目标最多保留 50 次运行，且超过 30 天的记录一律清理。
//
// 本包不依赖 Wails；应用日志（internal/applog）由调用方注入，记下中断、损坏、
// 清理失败这类运行器自身的行迹。
//
// 设计规格：docs/superpowers/specs/2026-11-24-ai-system-and-schedules-design.md（运行记录、进程模型）
package runstore

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"workflow-tool/internal/applog"
	"workflow-tool/internal/procinfo"
	"workflow-tool/internal/target"
)

// 目标种类：一次运行所指的可执行物，三选一。与调度共用同一套词汇（internal/target）。
const (
	KindAction   = target.Action
	KindWorkflow = target.Workflow
	KindAI       = target.AI
)

// Origin 是发起来源，三选一：调度到点 / 立即运行（人触发，按某条调度的参数）/ 手动运行。
const (
	OriginSchedule = "schedule"
	OriginRunNow   = "run-now"
	OriginManual   = "manual"
)

// 状态词汇。skipped 与 missed 不是失败：前者是调度到点时目标正在运行、因而不发起运行；
// 后者是应用未在运行时溜走的调度时刻。两者都只留一条没有过程的记录。
const (
	StatusRunning     = "running"
	StatusSucceeded   = "succeeded"
	StatusFailed      = "failed"
	StatusCancelled   = "cancelled"
	StatusInterrupted = "interrupted"
	StatusSkipped     = "skipped"
	StatusMissed      = "missed"
)

// Process.Mode 的取值：in-app = 应用进程内的运行；executor = 独立执行器的运行。
const (
	ProcessInApp    = "in-app"
	ProcessExecutor = "executor"
)

// InterruptedReason 是启动对账时给遗留 running 记录写的原因：按承载的进程分两种。
const (
	InterruptedReason         = "应用退出时仍在运行，未能得出结果"
	ExecutorInterruptedReason = "执行器退出时仍在运行，未能得出结果"
)

const (
	// DirName 是应用目录下存放运行记录的目录名。
	DirName = "runs"
	// RecordFile 与 EventsFile 是每个运行目录下的两个文件；StopFile 是停止标记。
	RecordFile = "run.json"
	EventsFile = "events.ndjson"
	StopFile   = "STOP"
	// KeepPerTarget 是每个目标最多保留的运行次数；MaxAge 是记录的最长保留期。
	KeepPerTarget = 50
	MaxAge        = 30 * 24 * time.Hour
	// MaxEventLogBytes 是单个运行日志的上限。持续输出的动作（如 logcat-stream）
	// 与大体积树帧会让日志无限增长，到达上限后停止落盘并写一行 truncated 标记。
	MaxEventLogBytes = 16 << 20
	// HeartbeatInterval 是执行器回写心跳的间隔；超过 HeartbeatStale 没有心跳视为过期，
	// 此时改按进程身份（pid 与启动时刻）判断执行器是否还在。
	HeartbeatInterval = 10 * time.Second
	HeartbeatStale    = 30 * time.Second
)

// AliveFunc 是进程身份核对函数的类型（别名自 procinfo.AliveFunc）：认领执行器时用，
// 默认 procinfo.Alive，测试注入。
type AliveFunc = procinfo.AliveFunc

// ErrNotFound 表示没有这个 run-id 对应的运行记录。
var ErrNotFound = errors.New("run record not found")

// Target 是一次运行所指的目标。
type Target = target.Target

// Process 是承载本次运行的进程信息。
//   - mode：in-app = 应用进程内的运行；executor = 独立执行器的运行。
//   - pid 与 started_at 在此落档：认领一条仍在运行的记录时用两者核对进程身份——只比 pid
//     不够，pid 会被复用。
//   - heartbeat_at：仅执行器运行有，执行器运行期间定期回写。
type Process struct {
	Mode        string `json:"mode"`
	PID         int    `json:"pid"`
	StartedAt   string `json:"started_at,omitempty"`
	HeartbeatAt string `json:"heartbeat_at,omitempty"`
}

// Record 是一条运行记录（run.json 的形状）。索引里只驻留元数据：Outputs 与 Rules
// 只在盘上，经 Get 读取完整记录。
type Record struct {
	ID         string            `json:"id"`
	Target     Target            `json:"target"`
	Origin     string            `json:"origin"`
	ScheduleID string            `json:"schedule_id,omitempty"`
	Params     map[string]any    `json:"params"`
	Status     string            `json:"status"`
	Reason     string            `json:"reason"`
	StartedAt  time.Time         `json:"started_at"`
	FinishedAt *time.Time        `json:"finished_at,omitempty"`
	ExitCode   *int              `json:"exit_code,omitempty"`
	Outputs    map[string]string `json:"outputs,omitempty"`
	Process    *Process          `json:"process,omitempty"`
	// Rules 仅 AI 运行有：本次注入的无人值守守则全文。任务的 YAML 不是发给 Agent
	// 的完整系统提示，守则改版后只有这里能还原当时注入的是什么。
	Rules string `json:"rules,omitempty"`
}

// Filter 是列表筛选条件；零值字段表示不限。
type Filter struct {
	TargetKind target.Kind
	TargetID   string
	Status     string
	Origin     string
	Limit      int // 0 = 不限
}

// Event 是运行日志的一行。Output/Done 事件的字段与前端收到的事件同构。
type Event struct {
	// T 是相对启动时刻的毫秒偏移，回放时据此还原工序段的时间轴。
	T        int64          `json:"t"`
	Event    string         `json:"event"` // "output" | "done" | "truncated"
	Stream   string         `json:"stream,omitempty"`
	Line     string         `json:"line,omitempty"`
	Step     string         `json:"step,omitempty"`
	Seq      int64          `json:"seq,omitempty"` // 后端从 1 起取号，0 即缺省
	ExitCode int            `json:"exitCode,omitempty"`
	Err      string         `json:"err,omitempty"`
	Duration string         `json:"duration,omitempty"`
	Readout  map[string]any `json:"readout,omitempty"`
	// Limit 只在 truncated 标记行上有：到达的字节上限。
	Limit int64 `json:"limit,omitempty"`
}

type options struct {
	maxEventLogBytes int64
	keepPerTarget    int
	maxAge           time.Duration
	alive            AliveFunc
	now              func() time.Time // 测试注入；nil 用 time.Now
}

func defaultOptions() options {
	return options{maxEventLogBytes: MaxEventLogBytes, keepPerTarget: KeepPerTarget, maxAge: MaxAge, alive: procinfo.Alive}
}

// Store 管理应用目录下的全部运行记录。内存里维护一份元数据索引，列表与「最近一次」
// 查询不读盘；*Store 为 nil 时所有方法都是空操作。
type Store struct {
	dir  string // <baseDir>/runs
	log  *applog.Logger
	opts options
	// now 是时钟，测试注入；仅供 Store 自己取时间（Session 的相对偏移用单调时钟）。
	now func() time.Time

	mu      sync.Mutex
	records map[string]Record // run-id → 元数据（Outputs/Rules 置空）
}

// Open 打开（或首次建立）baseDir 下的运行记录索引。目录尚不存在时视为空，且不预建
// 目录——第一条运行开始时才创建。
//
// 启动时逐条检查遗留的 running 记录：
//   - 应用内的运行随应用退出必然终止，一律改写为 interrupted；
//   - 执行器的运行按心跳与进程身份认领：心跳新鲜，或心跳虽过期但进程仍在，就仍是
//     running（之后由 Poll 持续核对）；确认不在的改写为 interrupted。
//
// 无法解析的记录跳过并记一条应用日志。
func Open(baseDir string, logger *applog.Logger) (*Store, error) {
	return open(baseDir, logger, defaultOptions())
}

func open(baseDir string, logger *applog.Logger, opts options) (*Store, error) {
	// 零值字段补成默认值：调用方只关心覆盖其中一两项时不必记得其余的。
	if opts.maxEventLogBytes <= 0 {
		opts.maxEventLogBytes = MaxEventLogBytes
	}
	if opts.keepPerTarget <= 0 {
		opts.keepPerTarget = KeepPerTarget
	}
	if opts.maxAge <= 0 {
		opts.maxAge = MaxAge
	}
	if opts.alive == nil {
		opts.alive = procinfo.Alive
	}
	if opts.now == nil {
		opts.now = time.Now
	}
	s := &Store{
		dir:     filepath.Join(baseDir, DirName),
		log:     logger,
		opts:    opts,
		now:     opts.now,
		records: make(map[string]Record),
	}
	entries, err := os.ReadDir(s.dir)
	if errors.Is(err, os.ErrNotExist) {
		return s, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read runs dir %q: %w", s.dir, err)
	}
	now := s.now()
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		id := entry.Name()
		rec, err := readRecordFile(s.recordPath(id))
		if errors.Is(err, os.ErrNotExist) {
			continue // 尚无 run.json：启动写到一半的残留，不是记录
		}
		if err != nil {
			s.log.Log("run.record.unreadable", map[string]any{"run_id": id, "error": err.Error()})
			continue
		}
		if rec.Status == StatusRunning && !s.claimed(&rec) {
			// 结束时刻不可知：不编造 finished_at。
			interrupted, ok := s.interrupt(rec, interruptReason(rec))
			if !ok {
				continue
			}
			rec = interrupted
		}
		s.records[id] = lite(rec)
	}
	s.mu.Lock()
	s.pruneLocked(now)
	s.mu.Unlock()
	return s, nil
}

// claimed 判定一条遗留的 running 记录是否仍在运行：应用内的运行必然已终止；执行器的
// 运行看心跳，心跳过期再看进程是否还在。
func (s *Store) claimed(rec *Record) bool {
	if rec.Process == nil || rec.Process.Mode != ProcessExecutor || !s.executorAlive(*rec) {
		return false
	}
	s.log.Log("run.claimed", map[string]any{"run_id": rec.ID, "target": rec.Target,
		"origin": rec.Origin, "schedule_id": rec.ScheduleID, "started_at": rec.StartedAt})
	return true
}

// executorAlive 报告一条执行器运行是否还在跑：心跳在 HeartbeatStale 之内算在；心跳过期
// 时核对 pid 与启动时间，进程仍在就再等一个心跳周期——机器刚从睡眠恢复时心跳看起来
// 过期，执行器其实还活着。
func (s *Store) executorAlive(rec Record) bool {
	if heartbeat, err := time.Parse(time.RFC3339Nano, rec.Process.HeartbeatAt); err == nil {
		if elapsed := s.now().Sub(heartbeat); elapsed >= 0 && elapsed <= HeartbeatStale {
			return true
		}
	}
	return s.opts.alive(rec.Process.PID, rec.Process.StartedAt)
}

func interruptReason(rec Record) string {
	if rec.Process != nil && rec.Process.Mode == ProcessExecutor {
		return ExecutorInterruptedReason
	}
	return InterruptedReason
}

// interrupt 把一条 running 记录改写为 interrupted 并记一条应用日志；写盘失败时 ok=false。
func (s *Store) interrupt(rec Record, reason string) (Record, bool) {
	rec.Status, rec.Reason = StatusInterrupted, reason
	if err := s.writeRecord(&rec); err != nil {
		s.log.Log("run.interrupted", map[string]any{"run_id": rec.ID, "error": err.Error()})
		return Record{}, false
	}
	s.log.Log("run.interrupted", map[string]any{"run_id": rec.ID, "target": rec.Target,
		"origin": rec.Origin, "schedule_id": rec.ScheduleID, "started_at": rec.StartedAt})
	return rec, true
}

// Poll 核对一条执行器运行并同步索引，应用为它打开着的时候定期调用。返回 ended=true
// 表示这次核对发现运行已结束（rec 是终态）：执行器自己写了终态，或执行器已不在、
// 这里改写成了 interrupted。只管执行器运行——应用内的运行有自己的执行路径，不读盘。
func (s *Store) Poll(id string) (rec Record, ended bool) {
	if s == nil {
		return Record{}, false
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	current, ok := s.records[id]
	if !ok || current.Status != StatusRunning || current.Process == nil || current.Process.Mode != ProcessExecutor {
		return Record{}, false
	}
	onDisk, err := readRecordFile(s.recordPath(id))
	if err != nil {
		// 读不出来（IO 抖动、写到一半）：这一次不动，下次再核对。
		s.log.Log("run.poll.failed", map[string]any{"run_id": id, "error": err.Error()})
		return Record{}, false
	}
	if onDisk.Status != StatusRunning {
		s.records[id] = lite(onDisk)
		return lite(onDisk), true
	}
	s.records[id] = lite(onDisk)
	if s.executorAlive(onDisk) {
		return Record{}, false
	}
	interrupted, ok := s.interrupt(onDisk, ExecutorInterruptedReason)
	if !ok {
		return Record{}, false
	}
	s.records[id] = lite(interrupted)
	return lite(interrupted), true
}

// RequestStop 请求停止一条运行：在它的目录下写停止标记。执行器每秒轮询，见到即取消
// （杀进程组，以 cancelled 收尾）——不依赖 POSIX 信号，Windows 同样可用。
func (s *Store) RequestStop(id string) error {
	if s == nil {
		return nil
	}
	if !validRunID(id) {
		return ErrNotFound
	}
	if err := os.WriteFile(filepath.Join(s.runDir(id), StopFile), nil, 0o644); err != nil {
		return fmt.Errorf("write stop marker for run %q: %w", id, err)
	}
	return nil
}

// Attach 让执行器接手一条 running 记录：进程信息换成自己的，运行日志续在同一个文件里。
// 只能接手还在 running 的记录——终态只写一次，已终结的不再改写。
func Attach(baseDir, runID string) (*Session, error) {
	if !validRunID(runID) {
		return nil, fmt.Errorf("attach run %q: not a run id", runID)
	}
	s := &Store{dir: filepath.Join(baseDir, DirName), opts: defaultOptions(), now: time.Now,
		records: make(map[string]Record)}
	rec, err := readRecordFile(s.recordPath(runID))
	if errors.Is(err, os.ErrNotExist) {
		return nil, fmt.Errorf("attach run %q: %w", runID, ErrNotFound)
	}
	if err != nil {
		return nil, fmt.Errorf("attach run %q: %w", runID, err)
	}
	if rec.Status != StatusRunning {
		return nil, fmt.Errorf("attach run %q: already %s", runID, rec.Status)
	}
	pid, startedAt := procinfo.Self()
	// 第一次心跳立刻落下：执行器刚接手时，应用核对这条记录只认心跳与进程身份。
	rec.Process = &Process{Mode: ProcessExecutor, PID: pid, StartedAt: startedAt,
		HeartbeatAt: s.now().Format(time.RFC3339Nano)}
	if err := s.writeRecord(&rec); err != nil {
		return nil, err
	}
	file, err := os.OpenFile(filepath.Join(s.runDir(runID), EventsFile), os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return nil, fmt.Errorf("open run log %q: %w", filepath.Join(s.runDir(runID), EventsFile), err)
	}
	s.records[runID] = lite(rec)
	// 偏移仍以记录里的启动时刻为起点：接手前后是同一次运行。
	return &Session{store: s, id: runID, target: rec.Target, origin: rec.Origin, start: rec.StartedAt, file: file}, nil
}

// Start 登记一次运行的开始：写 running 的 run.json、新建运行日志，并按保留策略清理。
// rec.ID 与 rec.StartedAt 由 Store 填充；Params 被快照（之后调用方改动不影响记录），
// 必须可 JSON 编码，否则返回错误且不留目录。Store 为 nil（运行记录不可用）时返回
// nil 会话，调用方照常运行。
func (s *Store) Start(rec Record) (*Session, error) {
	return s.start(rec, true, "", "")
}

// Note 记一条没有运行过程的运行：不发起进程、不建运行日志、不带进程信息，直接落
// 终态。调度到点撞上运行中的目标（skipped）与启动失败（failed）都走这里——它们
// 没有输出流可回放，但同样是「一次运行」的事实。
func (s *Store) Note(rec Record, status, reason string) (*Session, error) {
	if status == StatusRunning {
		return nil, fmt.Errorf("note status must be terminal, got %q", status)
	}
	return s.start(rec, false, status, reason)
}

func (s *Store) start(rec Record, withLog bool, noteStatus, noteReason string) (*Session, error) {
	if s == nil {
		return nil, nil
	}
	// 先快照并验证可编码：留下半个目录比没有记录更糟。
	snapshot, err := snapshotJSON(rec.Params)
	if err != nil {
		return nil, fmt.Errorf("run params are not JSON encodable: %w", err)
	}
	rec.Params = snapshot
	if rec.StartedAt.IsZero() {
		rec.StartedAt = s.now()
	}
	if withLog && rec.Process == nil {
		pid, startedAt := procinfo.Self()
		rec.Process = &Process{Mode: ProcessInApp, PID: pid, StartedAt: startedAt}
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	id, err := s.reserveIDLocked(rec.StartedAt)
	if err != nil {
		return nil, err
	}
	rec.ID = id
	dir := s.runDir(id)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, fmt.Errorf("create run dir %q: %w", dir, err)
	}
	if !withLog {
		now := s.now()
		rec.Status = noteStatus
		rec.Reason = noteReason
		rec.FinishedAt = &now
		if err := s.writeRecord(&rec); err != nil {
			_ = os.RemoveAll(dir)
			return nil, err
		}
		s.records[id] = lite(rec)
		s.pruneLocked(s.now())
		return &Session{store: s, id: id, target: rec.Target, origin: rec.Origin, start: rec.StartedAt, done: true}, nil
	}
	rec.Status = StatusRunning
	if err := s.writeRecord(&rec); err != nil {
		_ = os.RemoveAll(dir)
		return nil, err
	}
	file, err := os.OpenFile(filepath.Join(dir, EventsFile), os.O_CREATE|os.O_WRONLY|os.O_APPEND|os.O_TRUNC, 0o644)
	if err != nil {
		_ = os.RemoveAll(dir)
		return nil, fmt.Errorf("create run log %q: %w", filepath.Join(dir, EventsFile), err)
	}
	s.records[id] = lite(rec)
	s.pruneLocked(s.now())
	return &Session{store: s, id: id, target: rec.Target, origin: rec.Origin, start: time.Now(), file: file}, nil
}

// reserveIDLocked 生成未被占用的 run-id：r<YYYYMMDD-HHMMSS>-<6 位十六进制>。
// 同一秒内的多次启动靠随机后缀区分，撞上目录已存在则重试。调用方须持有 s.mu。
func (s *Store) reserveIDLocked(started time.Time) (string, error) {
	prefix := "r" + started.Format("20060102-150405")
	for range 8 {
		var buf [3]byte
		if _, err := rand.Read(buf[:]); err != nil {
			return "", fmt.Errorf("generate run id: %w", err)
		}
		id := prefix + "-" + hex.EncodeToString(buf[:])
		if _, taken := s.records[id]; taken {
			continue
		}
		if _, err := os.Stat(s.runDir(id)); errors.Is(err, os.ErrNotExist) {
			return id, nil
		}
	}
	return "", fmt.Errorf("generate run id: no free id for %q", prefix)
}

// Get 返回一条完整的运行记录（含产出与守则），从盘上读取。
func (s *Store) Get(id string) (Record, error) {
	if s == nil {
		return Record{}, ErrNotFound
	}
	if !validRunID(id) {
		return Record{}, ErrNotFound
	}
	rec, err := readRecordFile(s.recordPath(id))
	if errors.Is(err, os.ErrNotExist) {
		return Record{}, ErrNotFound
	}
	if err != nil {
		return Record{}, fmt.Errorf("read run %q: %w", id, err)
	}
	return rec, nil
}

// Events 返回一条运行的运行日志；没有日志文件（跳过的运行）时为空。
func (s *Store) Events(id string) ([]Event, error) {
	if s == nil {
		return nil, nil
	}
	if !validRunID(id) {
		return nil, ErrNotFound
	}
	data, err := os.ReadFile(filepath.Join(s.runDir(id), EventsFile))
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read run log %q: %w", id, err)
	}
	var events []Event
	for _, line := range strings.Split(string(data), "\n") {
		if strings.TrimSpace(line) == "" {
			continue
		}
		var ev Event
		if err := json.Unmarshal([]byte(line), &ev); err != nil {
			// 容忍半行（写到一半时崩溃）：丢掉它，其余照常回放。
			continue
		}
		events = append(events, ev)
	}
	return events, nil
}

// List 按启动时间倒序（最新在前）返回匹配筛选条件的运行记录元数据。
func (s *Store) List(filter Filter) []Record {
	if s == nil {
		return nil
	}
	s.mu.Lock()
	matches := make([]Record, 0, len(s.records))
	for _, rec := range s.records {
		if filter.TargetKind != "" && rec.Target.Kind != filter.TargetKind {
			continue
		}
		if filter.TargetID != "" && rec.Target.ID != filter.TargetID {
			continue
		}
		if filter.Status != "" && rec.Status != filter.Status {
			continue
		}
		if filter.Origin != "" && rec.Origin != filter.Origin {
			continue
		}
		matches = append(matches, rec)
	}
	s.mu.Unlock()
	sort.Slice(matches, func(i, j int) bool {
		if !matches[i].StartedAt.Equal(matches[j].StartedAt) {
			return matches[i].StartedAt.After(matches[j].StartedAt)
		}
		return matches[i].ID > matches[j].ID
	})
	if filter.Limit > 0 && len(matches) > filter.Limit {
		matches = matches[:filter.Limit]
	}
	return matches
}

// Latest 返回某目标最近一次运行。scheduleID 非空时只看该调度发起的运行；
// realOnly 为 true 时跳过 skipped 与 missed——它们都不是真实运行，不覆盖上一次真实运行的结果。
func (s *Store) Latest(targetKind target.Kind, targetID, scheduleID string, realOnly bool) (Record, bool) {
	if s == nil {
		return Record{}, false
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	var best Record
	found := false
	for _, rec := range s.records {
		if rec.Target.Kind != targetKind || rec.Target.ID != targetID {
			continue
		}
		if scheduleID != "" && rec.ScheduleID != scheduleID {
			continue
		}
		if realOnly && !isRealRun(rec) {
			continue
		}
		if !found || rec.StartedAt.After(best.StartedAt) || (rec.StartedAt.Equal(best.StartedAt) && rec.ID > best.ID) {
			best, found = rec, true
		}
	}
	return best, found
}

// LatestScheduled 返回某条调度最近一次到点留下的记录，不论结果（真实运行或跳过）。
// 调度卡据此判断「上次到点是不是被跳过了」：跳过只说明最近一次到点，之后一旦有过
// 真实运行就不再显示。
func (s *Store) LatestScheduled(scheduleID string) (Record, bool) {
	if s == nil {
		return Record{}, false
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	var best Record
	found := false
	for _, rec := range s.records {
		if rec.ScheduleID != scheduleID {
			continue
		}
		if !found || rec.StartedAt.After(best.StartedAt) || (rec.StartedAt.Equal(best.StartedAt) && rec.ID > best.ID) {
			best, found = rec, true
		}
	}
	return best, found
}

// finalizeLocked 落一条终态并更新索引。索引里该记录已是终态时拒绝（终态只写一次）。
// 调用方须持有 s.mu。
func (s *Store) finalizeLocked(rec Record) (bool, error) {
	if cur, ok := s.records[rec.ID]; ok && cur.Status != StatusRunning {
		return false, nil
	}
	if err := s.writeRecord(&rec); err != nil {
		return false, err
	}
	s.records[rec.ID] = lite(rec)
	s.pruneLocked(s.now())
	return true, nil
}

// isRealRun 报告一条记录是不是一次真实运行：跳过与错过只是到点的留痕，没有发起运行。
func isRealRun(rec Record) bool {
	return rec.Status != StatusSkipped && rec.Status != StatusMissed
}

// pruneLocked 执行保留策略：超过保留期的终态记录一律清理；每个目标只留最近
// keepPerTarget 次运行。运行中的记录不动。只清理索引里的记录，目录下的其他条目不碰。
//
// 没有发起运行的到点（跳过、错过）单独计配额：它们不覆盖上一次真实运行的结果，所以
// 也不能把真实记录挤出保留窗口——否则一条每分钟到点、目标长期被占用的调度，不到一小时
// 就能让最近结果落空。
// 调用方须持有 s.mu。
func (s *Store) pruneLocked(now time.Time) {
	type bucket struct {
		target  Target
		notReal bool
	}
	byBucket := make(map[bucket][]string)
	for id, rec := range s.records {
		if rec.Status == StatusRunning {
			continue
		}
		if now.Sub(rec.StartedAt) > s.opts.maxAge {
			s.removeLocked(id, "expired")
			continue
		}
		key := bucket{target: rec.Target, notReal: !isRealRun(rec)}
		byBucket[key] = append(byBucket[key], id)
	}
	for key, ids := range byBucket {
		if len(ids) <= s.opts.keepPerTarget {
			continue
		}
		started := make(map[string]time.Time, len(ids))
		for _, id := range ids {
			started[id] = s.records[id].StartedAt
		}
		sort.Slice(ids, func(i, j int) bool {
			if !started[ids[i]].Equal(started[ids[j]]) {
				return started[ids[i]].Before(started[ids[j]])
			}
			return ids[i] < ids[j]
		})
		for _, id := range ids[:len(ids)-s.opts.keepPerTarget] {
			s.removeLocked(id, fmt.Sprintf("over cap for %s %q", key.target.Kind, key.target.ID))
		}
	}
}

// removeLocked 删除一条记录的目录与索引项；失败只记日志。调用方须持有 s.mu。
func (s *Store) removeLocked(id, why string) {
	if err := os.RemoveAll(s.runDir(id)); err != nil {
		s.log.Log("run.prune.failed", map[string]any{"run_id": id, "reason": why, "error": err.Error()})
		return
	}
	delete(s.records, id)
}

func (s *Store) runDir(id string) string     { return filepath.Join(s.dir, id) }
func (s *Store) recordPath(id string) string { return filepath.Join(s.runDir(id), RecordFile) }

// writeRecord 原子写 run.json：先写同目录临时文件再改名，读的一方永远看不到半个文件。
func (s *Store) writeRecord(rec *Record) error {
	data, err := encodeJSONIndent(rec)
	if err != nil {
		return fmt.Errorf("encode run %q: %w", rec.ID, err)
	}
	path := s.recordPath(rec.ID)
	tmp, err := os.CreateTemp(filepath.Dir(path), "."+RecordFile+".*.tmp")
	if err != nil {
		return fmt.Errorf("create temp run record for %q: %w", path, err)
	}
	tmpName := tmp.Name()
	cleanup := func() { _ = os.Remove(tmpName) }
	if _, err := tmp.Write(data); err != nil {
		_ = tmp.Close()
		cleanup()
		return fmt.Errorf("write temp run record %q: %w", tmpName, err)
	}
	if err := tmp.Close(); err != nil {
		cleanup()
		return fmt.Errorf("close temp run record %q: %w", tmpName, err)
	}
	if err := os.Rename(tmpName, path); err != nil {
		cleanup()
		return fmt.Errorf("replace run record %q: %w", path, err)
	}
	return nil
}

func readRecordFile(path string) (Record, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return Record{}, err
	}
	var rec Record
	if err := json.Unmarshal(data, &rec); err != nil {
		return Record{}, err
	}
	if rec.ID == "" || rec.Target.Kind == "" || rec.Target.ID == "" {
		return Record{}, fmt.Errorf("run record lacks id or target")
	}
	return rec, nil
}

// validRunID 拒绝一切不是 run-id 形状的输入，防止路径穿越拼进文件路径。
func validRunID(id string) bool {
	if len(id) == 0 || len(id) > 64 {
		return false
	}
	for _, c := range id {
		switch {
		case c >= 'a' && c <= 'z', c >= '0' && c <= '9', c == '-':
		default:
			return false
		}
	}
	return true
}

// smallOutputs 是留在内存索引里的产出键：读数类的小标量，列表与卡片投影要用
// （会话 id、费用、token）。正文类产出（text / thinking / stdout / stderr）可能有几十 KB，
// 只留在盘上，经 Get 读取。
var smallOutputs = map[string]bool{
	"session_id": true, "cost_usd": true,
	"input_tokens": true, "output_tokens": true, "total_tokens": true,
	"exit_code": true, "success": true,
}

// lite 返回索引用的元数据副本：正文类产出与守则全文只留在盘上。
func lite(rec Record) Record {
	if rec.Outputs == nil {
		return rec
	}
	small := make(map[string]string, len(smallOutputs))
	for k, v := range rec.Outputs {
		if smallOutputs[k] {
			small[k] = v
		}
	}
	rec.Outputs = small
	rec.Rules = ""
	return rec
}

// Outcome 把一次运行的结果归入状态词汇。取消是人主动终止；超时不算取消，是失败，
// 原因注明超时。命令非零退出且没有错误对象时，原因写退出码。
func Outcome(exitCode int, err error) (status, reason string) {
	switch {
	case errors.Is(err, context.Canceled):
		return StatusCancelled, ""
	case errors.Is(err, context.DeadlineExceeded):
		if err == context.DeadlineExceeded {
			return StatusFailed, "超时"
		}
		// 包装过的超时错误带着可行动的文案（如续接会话的办法），原样保留。
		return StatusFailed, err.Error()
	case exitCode == 0 && err == nil:
		return StatusSucceeded, ""
	}
	if err != nil {
		return StatusFailed, err.Error()
	}
	return StatusFailed, fmt.Sprintf("退出码 %d", exitCode)
}

// snapshotJSON 把 params 深拷贝成纯 JSON 值（经一轮编解码），nil 视为空对象。
func snapshotJSON(params map[string]any) (map[string]any, error) {
	if params == nil {
		return map[string]any{}, nil
	}
	data, err := encodeJSON(params)
	if err != nil {
		return nil, err
	}
	var out map[string]any
	if err := json.Unmarshal(data, &out); err != nil {
		return nil, err
	}
	if out == nil {
		out = map[string]any{}
	}
	return out, nil
}

func encodeJSON(v any) ([]byte, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return nil, err
	}
	return bytes.TrimSuffix(buf.Bytes(), []byte("\n")), nil
}

func encodeJSONIndent(v any) ([]byte, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", "  ")
	if err := enc.Encode(v); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil // 保留结尾换行
}

// Session 是一次运行记录的写入端。Start 取得，运行结束调 Finish；*Session 为 nil
// 时所有方法都是空操作——运行记录写不进去时运行照常进行。
type Session struct {
	store  *Store
	id     string
	target Target    // 这次运行的目标：收尾时随 runs:changed 通知出去
	origin string    // 发起来源：执行器落终态时据此区分「调度撞锁 → skipped」与其它失败
	start  time.Time // 相对偏移的起点（单调时钟）

	mu        sync.Mutex
	file      *os.File
	written   int64
	truncated bool
	done      bool
	rules     string
}

// ID 返回 run-id（目录名）。nil 会话返回空串。
func (s *Session) ID() string {
	if s == nil {
		return ""
	}
	return s.id
}

// Origin 返回这次运行的发起来源（schedule / run-now / manual）。执行器落终态时据此
// 区分「调度到点撞上运行中的目标」（skipped）与其他失败。
func (s *Session) Origin() string {
	if s == nil {
		return ""
	}
	return s.origin
}

// Target 返回这次运行的目标。
func (s *Session) Target() Target {
	if s == nil {
		return Target{}
	}
	return s.target
}

// Params 返回这次运行的输入（记录里留存的那份）。执行器接手一条记录时据此取得输入。
func (s *Session) Params() map[string]any {
	if s == nil {
		return nil
	}
	s.store.mu.Lock()
	defer s.store.mu.Unlock()
	return s.store.records[s.id].Params
}

// Output 落一条 output 事件。payload 与前端收到的事件同构（stream/line/seq/step）。
func (s *Session) Output(payload map[string]any) { s.write("output", payload) }

// Done 落一条 done 事件。payload 与前端收到的结束事件同构
// （exitCode/err/duration/seq/readout）。
func (s *Session) Done(payload map[string]any) { s.write("done", payload) }

func (s *Session) write(kind string, payload map[string]any) {
	if s == nil {
		return
	}
	line := make(map[string]any, len(payload)+2)
	line["t"] = time.Since(s.start).Milliseconds()
	line["event"] = kind
	for k, v := range payload {
		line[k] = v
	}
	data, err := encodeJSON(line)
	if err != nil {
		return // 不可编码的事件：丢弃，不影响运行
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.done || s.file == nil || s.truncated {
		return
	}
	limit := s.store.opts.maxEventLogBytes
	if s.written > 0 && s.written+int64(len(data))+1 > limit {
		s.truncated = true
		marker, _ := encodeJSON(map[string]any{"t": time.Since(s.start).Milliseconds(), "event": "truncated", "limit": limit})
		n, _ := s.file.Write(append(marker, '\n'))
		s.written += int64(n)
		return
	}
	n, _ := s.file.Write(append(data, '\n'))
	s.written += int64(n)
}

// SetRules 记下本次 AI 运行注入的守则全文，随终态一并落档。
func (s *Session) SetRules(rules string) {
	if s == nil {
		return
	}
	s.mu.Lock()
	s.rules = rules
	s.mu.Unlock()
}

// Heartbeat 是执行器的跳动：把当前时刻写回 run.json 的 process.heartbeat_at。
// 应用据它判断执行器还在不在（见 Open 与 Poll）。非执行器会话与已终结的会话是空操作。
func (s *Session) Heartbeat() {
	if s == nil {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.done || s.file == nil {
		return
	}
	s.store.mu.Lock()
	defer s.store.mu.Unlock()
	rec, ok := s.store.records[s.id]
	if !ok || rec.Status != StatusRunning || rec.Process == nil {
		return
	}
	rec.Process.HeartbeatAt = s.store.now().Format(time.RFC3339Nano)
	if err := s.store.writeRecord(&rec); err != nil {
		s.store.log.Log("run.heartbeat.failed", map[string]any{"run_id": s.id, "error": err.Error()})
		return
	}
	s.store.records[s.id] = lite(rec)
}

// Detach 把这条记录交出去：应用为执行器建好记录后不再写它，日志、心跳与终态都由
// 执行器落。此后 Finish 是空操作——终态只能由接手的一方写。
func (s *Session) Detach() {
	if s == nil {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.done {
		return
	}
	s.done = true
	if s.file != nil {
		_ = s.file.Close()
		s.file = nil
	}
}

// Finish 写终态并关闭运行日志。只有第一次调用生效：返回 false 表示这条记录已经
// 终结（或会话为 nil），任何路径都不再改写。exitCode 为 nil 时不写 exit_code。
func (s *Session) Finish(status, reason string, exitCode *int, outputs map[string]string) bool {
	if s == nil {
		return false
	}
	s.mu.Lock()
	if s.done {
		s.mu.Unlock()
		return false
	}
	s.done = true
	var file *os.File
	file, s.file = s.file, nil
	rules := s.rules
	s.mu.Unlock()
	if file != nil {
		_ = file.Close()
	}
	// 停止标记随终态清掉：它只对这一次运行有意义。
	_ = os.Remove(filepath.Join(s.store.runDir(s.id), StopFile))
	if status == StatusRunning {
		status = StatusFailed
		reason = strings.TrimSpace(reason + "（内部错误：终态为 running）")
	}

	s.store.mu.Lock()
	defer s.store.mu.Unlock()
	rec, ok := s.store.records[s.id]
	if !ok {
		// 记录连同目录已被保留策略清掉（运行时长超过保留期）：无处可写，不再重建。
		return false
	}
	now := s.store.now()
	rec.Status = status
	rec.Reason = reason
	rec.FinishedAt = &now
	rec.ExitCode = exitCode
	rec.Outputs = outputs
	rec.Rules = rules
	written, err := s.store.finalizeLocked(rec)
	if err != nil {
		s.store.log.Log("run.finish.failed", map[string]any{"run_id": s.id, "status": status, "error": err.Error()})
	}
	return written
}
