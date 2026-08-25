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

// Node ≥22 的 experimental 原生 Web Storage 未启用时 globalThis.localStorage 为 undefined，
// 且该键被 Node 占住导致 vitest populateGlobal 跳过、jsdom 的实现不可达
// （window === globalThis，无从取原生实现）——补一个内存版 Storage 供测试用
if (!globalThis.localStorage || !globalThis.sessionStorage) {
  const makeStorage = (): Storage => {
    const map = new Map<string, string>();
    return {
      get length() {
        return map.size;
      },
      clear: () => map.clear(),
      getItem: (key: string) => (map.has(key) ? map.get(key)! : null),
      key: (index: number) => [...map.keys()][index] ?? null,
      removeItem: (key: string) => void map.delete(key),
      setItem: (key: string, value: string) => void map.set(key, String(value)),
    };
  };
  if (!globalThis.localStorage) {
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: makeStorage() });
  }
  if (!globalThis.sessionStorage) {
    Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: makeStorage() });
  }
}
