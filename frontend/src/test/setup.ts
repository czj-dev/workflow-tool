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

// base-ui ScrollArea 等组件依赖 ResizeObserver，jsdom 未实现
if (!globalThis.ResizeObserver) {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}

// base-ui ScrollArea Viewport 用 Web Animations API（Element.getAnimations），jsdom 未实现
if (!Element.prototype.getAnimations) {
  Element.prototype.getAnimations = function (): Animation[] {
    return [];
  };
}
