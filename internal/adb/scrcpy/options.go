package scrcpy

import (
	"fmt"
	"strconv"
	"strings"

	"workflow-tool/internal/adb"
)

// Options mirrors ADBKit's scrcpy Options, exposing every CLI flag the upstream
// service supported so callers can drive the full scrcpy surface.
type Options struct {
	MaxSize            int
	BitRate            int
	MaxFPS             int
	AudioBitRate       int
	AudioCodec         string
	VideoCodec         string
	ShowTouches        bool
	NoAudio            bool
	NoControl          bool
	StayAwake          bool
	TurnScreenOff      bool
	PowerOffOnClose    bool
	Fullscreen         bool
	AlwaysOnTop        bool
	DisableScreensaver bool
	Rotation           int
	DisplayID          int
	TimeLimit          int
}

// ToArgs translates Options into scrcpy CLI arguments for a foreground session.
// Ported from ADBKit service.go Options.ToArgs (defaults like h264/opus omitted).
func (o Options) ToArgs() []string {
	var args []string
	if o.MaxSize > 0 {
		args = append(args, "--max-size", strconv.Itoa(o.MaxSize))
	}
	if o.BitRate > 0 {
		args = append(args, "--video-bit-rate", strconv.Itoa(o.BitRate))
	}
	if o.MaxFPS > 0 {
		args = append(args, "--max-fps", strconv.Itoa(o.MaxFPS))
	}
	if o.AudioBitRate > 0 {
		args = append(args, "--audio-bit-rate", strconv.Itoa(o.AudioBitRate))
	}
	if o.AudioCodec != "" && o.AudioCodec != "opus" {
		args = append(args, "--audio-codec", o.AudioCodec)
	}
	if o.VideoCodec != "" && o.VideoCodec != "h264" {
		args = append(args, "--video-codec", o.VideoCodec)
	}
	if o.ShowTouches {
		args = append(args, "--show-touches")
	}
	if o.NoAudio {
		args = append(args, "--no-audio")
	}
	if o.NoControl {
		args = append(args, "--no-control")
	}
	if o.StayAwake {
		args = append(args, "--stay-awake")
	}
	if o.TurnScreenOff {
		args = append(args, "--turn-screen-off")
	}
	if o.PowerOffOnClose {
		args = append(args, "--power-off-on-close")
	}
	if o.Fullscreen {
		args = append(args, "--fullscreen")
	}
	if o.AlwaysOnTop {
		args = append(args, "--always-on-top")
	}
	if o.DisableScreensaver {
		args = append(args, "--disable-screensaver")
	}
	if o.Rotation > 0 {
		args = append(args, "--display-orientation", strconv.Itoa(o.Rotation))
	}
	if o.DisplayID > 0 {
		args = append(args, "--display-id", strconv.Itoa(o.DisplayID))
	}
	if o.TimeLimit > 0 {
		args = append(args, "--time-limit", strconv.Itoa(o.TimeLimit))
	}
	return args
}

// recordArgs returns the scrcpy flags relevant to headless recording. Mirrors the
// subset used by ADBKit recording.go (window-only flags like fullscreen are
// meaningless with --no-playback and are intentionally omitted).
func (o Options) recordArgs() []string {
	var args []string
	if o.BitRate > 0 {
		args = append(args, "--video-bit-rate", strconv.Itoa(o.BitRate))
	}
	if o.MaxFPS > 0 {
		args = append(args, "--max-fps", strconv.Itoa(o.MaxFPS))
	}
	if o.MaxSize > 0 {
		args = append(args, "--max-size", strconv.Itoa(o.MaxSize))
	}
	if o.VideoCodec != "" && o.VideoCodec != "h264" {
		args = append(args, "--video-codec", o.VideoCodec)
	}
	if o.NoAudio {
		args = append(args, "--no-audio")
	}
	return args
}

// optionsFromParams builds Options from the operation params. Param keys use the
// uppercase SCREAMING_SNAKE convention; values may arrive as JSON numbers
// (float64) or strings.
func optionsFromParams(op *adb.OpContext) Options {
	return Options{
		MaxSize:            paramInt(op.Params, "MAX_SIZE"),
		BitRate:            paramInt(op.Params, "BIT_RATE"),
		MaxFPS:             paramInt(op.Params, "MAX_FPS"),
		AudioBitRate:       paramInt(op.Params, "AUDIO_BIT_RATE"),
		AudioCodec:         op.ParamStr("AUDIO_CODEC"),
		VideoCodec:         op.ParamStr("VIDEO_CODEC"),
		ShowTouches:        op.ParamBool("SHOW_TOUCHES"),
		NoAudio:            op.ParamBool("NO_AUDIO"),
		NoControl:          op.ParamBool("NO_CONTROL"),
		StayAwake:          op.ParamBool("STAY_AWAKE"),
		TurnScreenOff:      op.ParamBool("TURN_SCREEN_OFF"),
		PowerOffOnClose:    op.ParamBool("POWER_OFF_ON_CLOSE"),
		Fullscreen:         op.ParamBool("FULLSCREEN"),
		AlwaysOnTop:        op.ParamBool("ALWAYS_ON_TOP"),
		DisableScreensaver: op.ParamBool("DISABLE_SCREENSAVER"),
		Rotation:           paramInt(op.Params, "ROTATION"),
		DisplayID:          paramInt(op.Params, "DISPLAY_ID"),
		TimeLimit:          paramInt(op.Params, "TIME_LIMIT"),
	}
}

// paramInt reads an integer param, tolerating JSON float64 / int / string forms.
func paramInt(params map[string]any, key string) int {
	v, ok := params[key]
	if !ok || v == nil {
		return 0
	}
	switch t := v.(type) {
	case float64:
		return int(t)
	case float32:
		return int(t)
	case int:
		return t
	case int64:
		return int(t)
	case string:
		n, _ := strconv.Atoi(strings.TrimSpace(t))
		return n
	default:
		n, _ := strconv.Atoi(fmt.Sprint(v))
		return n
	}
}
