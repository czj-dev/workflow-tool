import "@testing-library/jest-dom/vitest";
import "../i18n";
import { vi } from "vitest";

// jsdom 未实现 matchMedia：shadcn Sidebar 的 useIsMobile 依赖它
if (!window.matchMedia) {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}
