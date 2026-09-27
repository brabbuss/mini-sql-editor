/**
 * Browser globals for component tests (*.test.tsx), which run in Node under node:test. Import it first, before
 * anything that loads React or click-ui.
 */
import globalJsdom from 'global-jsdom';
import Module from 'node:module';

// A real origin, so localStorage works (on jsdom's default about:blank it throws)
globalJsdom(undefined, { url: 'http://localhost/' });

// Node has its own Event, CustomEvent and EventTarget, and global-jsdom leaves existing globals alone. Radix (in
// click-ui's dialogs) creates events with the global constructors and dispatches them on jsdom elements, which only
// accept jsdom's events, so these must be jsdom's
Object.assign(globalThis, { Event: window.Event, CustomEvent: window.CustomEvent, EventTarget: window.EventTarget });

// CodeMirror decides whether Mod is ⌘ or Ctrl from navigator.platform, once, when it loads. Node 21+ has its own
// navigator (reporting the real machine: "MacIntel", "Linux x86_64"…), which global-jsdom leaves in place; on Node 20
// there's only jsdom's, which reports "". Pinned, so keyboard tests behave the same on every machine and Node version
Object.defineProperty(navigator, 'platform', { value: 'MacIntel', configurable: true });

// Vite bundles click-ui's stylesheets in the app. Under Node, click-ui's require('./X.css') would fail to parse, so
// a required .css file loads as an empty module
const extensions = (Module as unknown as { _extensions: Record<string, (module: { exports: unknown }) => void> })
  ._extensions;
extensions['.css'] = (module) => {
  module.exports = {};
};

// jsdom has no layout: CodeMirror measures text ranges, so give it empty rectangles
Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
Range.prototype.getBoundingClientRect = () => new DOMRect();

// click-ui's Grid sizes itself to its container (react-virtualized-auto-sizer reads getBoundingClientRect; the Grid
// reads clientWidth for column widths) and only renders the cells that fit, and Recharts sizes the chart the same way.
// jsdom has no layout, so everything measures 0 and neither would draw anything. Only the grid and the chart get a
// window-sized box: given one too, CodeMirror would think each line is hundreds of pixels tall and only render the
// first couple of lines
const sized = (element: Element) => element.closest('.results-grid, .results-chart__plot') !== null;
const measure = HTMLElement.prototype.getBoundingClientRect;
HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
  return sized(this) ? new DOMRect(0, 0, 1024, 768) : measure.call(this);
};
Object.defineProperties(HTMLElement.prototype, {
  clientWidth: {
    configurable: true,
    get(this: HTMLElement) {
      return sized(this) ? 1024 : 0;
    }
  },
  clientHeight: {
    configurable: true,
    get(this: HTMLElement) {
      return sized(this) ? 768 : 0;
    }
  }
});

// Recharts' ResponsiveContainer only measures its container when ResizeObserver exists (it then reads the size once
// with getBoundingClientRect, stubbed above), and jsdom has none. Nothing resizes in a test, so it never reports
class NoResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver ??= NoResizeObserver as unknown as typeof ResizeObserver;
