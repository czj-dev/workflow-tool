package scrcpy

import "testing"

func TestStripPNGPrefix(t *testing.T) {
	body := pngMagic + "IHDR-and-pixels"

	// 干净 PNG：无前缀噪声，原样返回。
	png, noise, ok := stripPNGPrefix(body)
	if !ok || png != body || noise != "" {
		t.Fatalf("干净 PNG 应原样返回，got png=%q noise=%q ok=%v", png, noise, ok)
	}

	// 多 display 警告污染前缀：剥掉噪声、保留纯 PNG。
	warn := "[Warning] Multiple displays were found...\n"
	png, noise, ok = stripPNGPrefix(warn + body)
	if !ok || png != body || noise != warn {
		t.Fatalf("应剥掉前缀噪声，got png=%q noise=%q ok=%v", png, noise, ok)
	}

	// 完全不是 PNG：ok=false。
	if _, _, ok := stripPNGPrefix("not a png at all"); ok {
		t.Fatal("无 PNG 魔数应 ok=false")
	}
}
