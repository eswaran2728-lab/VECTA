// Minimal jsdom bootstrap for Phase 8 interactive client-component
// tests. React Server Components (the pages themselves -- they load
// data via async server calls and cannot run under jsdom/RTL) are NOT
// tested this way; this setup is scoped to the "use client" leaf
// components that own the actual interactive behavior (buttons, forms,
// loading/error states) -- server authorization is proven separately
// by the DB-integration suite and the server-action tests, never
// weakened or re-implemented here.
import { JSDOM } from "jsdom";

export function installJsdom() {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
  const { window } = dom;

  // @ts-expect-error -- assigning jsdom globals for React Testing Library
  global.window = window;
  global.document = window.document;
  Object.defineProperty(global, "navigator", { value: window.navigator, configurable: true, writable: true });
  global.HTMLElement = window.HTMLElement;
  global.Element = window.Element;
  global.Node = window.Node;
  global.File = window.File;
  global.FileList = window.FileList;
  global.getComputedStyle = window.getComputedStyle;
  global.requestAnimationFrame = (cb: FrameRequestCallback) => setTimeout(() => cb(Date.now()), 0) as unknown as number;
  global.cancelAnimationFrame = (id: number) => clearTimeout(id);
  // @ts-expect-error -- React Testing Library / React 19 act() environment flag
  global.IS_REACT_ACT_ENVIRONMENT = true;

  return dom;
}
