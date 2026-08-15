import { HugeiconsIcon } from "@hugeicons/react";
import {
  AiAudioIcon,
  AiChat02Icon,
  Alert02Icon,
  Camera02Icon,
  Cancel01Icon,
  Car01Icon,
  Clock01Icon,
  Copy01Icon,
  Download04Icon,
  File02Icon,
  FlashIcon,
  Folder02Icon,
  Loading03Icon,
  Mic01Icon,
  NoteIcon,
  PackageIcon,
  PlayIcon,
  RadioIcon,
  Settings02Icon,
  TestTubeIcon,
  TextIcon,
  Tick02Icon,
  Upload04Icon,
  VoiceIcon,
  FlowIcon,
} from "@hugeicons/core-free-icons";
import { cn } from "@/lib/utils";

// 动作图标注册表：YAML 里写 `icon: hi:<key>` 即渲染对应矢量图标。
// 未命中的 key / 不带前缀的内容（emoji、文本）一律原样渲染，向后兼容。
const REGISTRY = {
  play: PlayIcon,
  settings: Settings02Icon,
  alert: Alert02Icon,
  note: NoteIcon,
  workflow: FlowIcon,
  flash: FlashIcon,
  voice: VoiceIcon,
  mic: Mic01Icon,
  audio: AiAudioIcon,
  radio: RadioIcon,
  text: TextIcon,
  download: Download04Icon,
  copy: Copy01Icon,
  tick: Tick02Icon,
  cancel: Cancel01Icon,
  loading: Loading03Icon,
  ai: AiChat02Icon,
  car: Car01Icon,
  test: TestTubeIcon,
  file: File02Icon,
  package: PackageIcon,
  folder: Folder02Icon,
  upload: Upload04Icon,
  camera: Camera02Icon,
  clock: Clock01Icon,
} as const;

const PREFIX = "hi:";

export function ActionIcon({
  name,
  className,
}: {
  name?: string;
  className?: string;
}) {
  if (!name) return null;
  if (name.startsWith(PREFIX)) {
    const icon = REGISTRY[name.slice(PREFIX.length) as keyof typeof REGISTRY];
    if (icon) {
      return (
        <HugeiconsIcon
          icon={icon}
          strokeWidth={1.75}
          className={cn("size-4", className)}
        />
      );
    }
  }
  // emoji / 未命中文本：内容原样渲染，视觉与矢量图标统一——
  // 字号按 em 放大对齐 size-* 的视觉重量（emoji 字形不跟随 width/height），
  // 降饱和让全彩退后，与单色线条图标协调（浅深主题通用）
  return (
    <span className={cn("text-[1.25em] leading-none saturate-[0.35]", className)}>
      {name}
    </span>
  );
}
