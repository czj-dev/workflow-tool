// Package applog 是应用日志：记录调度与运行器自身的行迹（到点、跳过、错过、
// 认领、中断），与「某次运行的完整输出流」（运行日志，见 internal/runstore）相对。
//
// 落盘位置是可执行文件同级的 logs/app.log，NDJSON，每行一条：
//
//	{"time":"2026-11-25T02:15:00.123+08:00","event":"schedule.trigger","schedule_id":"nightly",...}
//
// 单文件 5MB，保留 3 份（app.log 与两份轮转备份）。日志失败永远不影响主流程：
// Log 不返回错误，Open 失败由调用方降级为不记日志。
//
// 设计规格：docs/superpowers/specs/2026-11-24-ai-system-and-schedules-design.md（应用日志）
package applog

import (
	"bytes"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// FileName 是日志文件名；MaxSize 是单个文件的上限；Keep 是保留的文件份数（含当前文件）。
const (
	FileName = "app.log"
	MaxSize  = 5 * 1024 * 1024
	Keep     = 3
)

// DirName 是应用目录下存放日志的目录名。
const DirName = "logs"

// Logger 是应用日志的写入端。零值不可用，经 Open 构造；*Logger 为 nil 时 Log/Close
// 是空操作，调用方不必判空。
type Logger struct {
	mu      sync.Mutex
	path    string
	file    *os.File // nil = 已关闭
	size    int64    // 当前文件已写入的字节数
	maxSize int64
	keep    int
}

// Open 在 baseDir 下打开（必要时创建）logs/app.log。目录无法创建或文件无法打开时
// 返回错误。
func Open(baseDir string) (*Logger, error) {
	return open(baseDir, MaxSize, Keep)
}

func open(baseDir string, maxSize int64, keep int) (*Logger, error) {
	logsDir := filepath.Join(baseDir, DirName)
	if err := os.MkdirAll(logsDir, 0o755); err != nil {
		return nil, fmt.Errorf("create log dir %q: %w", logsDir, err)
	}
	l := &Logger{path: filepath.Join(logsDir, FileName), maxSize: maxSize, keep: keep}
	if err := l.openFile(); err != nil {
		return nil, err
	}
	return l, nil
}

// openFile 以追加方式打开日志文件，并把已写入的字节数记到 size。
func (l *Logger) openFile() error {
	f, err := os.OpenFile(l.path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return fmt.Errorf("open app log %q: %w", l.path, err)
	}
	fi, err := f.Stat()
	if err != nil {
		f.Close()
		return fmt.Errorf("stat app log %q: %w", l.path, err)
	}
	l.file = f
	l.size = fi.Size()
	return nil
}

// Log 追加一行：{"time", "event", ...fields}。fields 可为 nil；键名 time / event 是
// 保留字，会被本行自带的时间与事件名覆盖。
//
// 写入前若本行会让文件超过上限则先轮转；空文件上即使单行超限也照写（一行不拆）。
// 任何失败（字段不可编码、写盘出错）都只丢弃这一条。
func (l *Logger) Log(event string, fields map[string]any) {
	if l == nil {
		return
	}
	out := make(map[string]any, len(fields)+2)
	out["time"] = time.Now()
	out["event"] = event
	for k, v := range fields {
		out[k] = v
	}
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(out); err != nil {
		log.Printf("app log: skip unencodable %q record: %v", event, err)
		return
	}
	line := buf.Bytes() // Encoder 自带结尾换行

	l.mu.Lock()
	defer l.mu.Unlock()
	if l.file == nil {
		return
	}
	if l.size > 0 && l.size+int64(len(line)) > l.maxSize {
		l.rotateLocked()
		if l.file == nil {
			return
		}
	}
	n, err := l.file.Write(line)
	l.size += int64(n)
	if err != nil {
		log.Printf("app log: write %q record: %v", event, err)
	}
}

// rotateLocked 把现有文件链向后挪一位并新开一个空文件：app.log.(keep-1) 删除，
// app.log.(keep-2) → app.log.(keep-1)，…，app.log → app.log.1。调用方须持有 l.mu。
func (l *Logger) rotateLocked() {
	l.file.Close()
	l.file = nil
	dir := filepath.Dir(l.path)
	for i := l.keep - 1; i >= 1; i-- {
		dst := filepath.Join(dir, fmt.Sprintf("%s.%d", FileName, i))
		src := l.path // i == 1 时源就是当前日志文件
		if i > 1 {
			src = filepath.Join(dir, fmt.Sprintf("%s.%d", FileName, i-1))
		}
		_ = os.Remove(dst)
		_ = os.Rename(src, dst)
	}
	if err := l.openFile(); err != nil {
		log.Printf("app log: reopen after rotation: %v", err)
	}
}

// Close 关闭日志文件；之后 Log 为空操作。重复调用安全。
func (l *Logger) Close() error {
	if l == nil {
		return nil
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.file == nil {
		return nil
	}
	err := l.file.Close()
	l.file = nil
	return err
}
