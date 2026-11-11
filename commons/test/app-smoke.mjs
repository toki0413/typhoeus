/**
 * app 启动冒烟（无浏览器）
 *
 * 用宽容的 DOM 桩把 app.js 的 module scope + boot() 跑一遍，
 * 抓拆分/重构后漏掉的 import、函数引用与 TDZ 错误。
 * 不替代真实浏览器渲染验证，只保证“模块能装配起来”。
 *
 * 运行：npm run test:smoke
 *       APP_ENTRY=./bundle.js npm run test:smoke   # 冒烟压缩后的产物
 */
function makeCtx(el) {
  const t = {
    canvas: el,
    measureText: () => ({ width: 10 }),
    createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
    getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
    createLinearGradient: () => ({ addColorStop() {} }),
    createRadialGradient: () => ({ addColorStop() {} }),
    createPattern: () => ({}),
    setTransform() {}, save() {}, restore() {}, clearRect() {}, fillRect() {}, strokeRect() {},
    beginPath() {}, arc() {}, fill() {}, stroke() {}, moveTo() {}, lineTo() {}, closePath() {},
    translate() {}, rotate() {}, scale() {}, drawImage() {}, putImageData() {},
    fillText() {}, strokeText() {}, ellipse() {}, rect() {}, clip() {},
    quadraticCurveTo() {}, bezierCurveTo() {}, roundRect() {},
  };
  return new Proxy(t, {
    get(o, p) { return p in o ? o[p] : () => undefined; },
    set(o, p, v) { o[p] = v; return true; },
  });
}

function makeEl(tag = 'div') {
  const el = {
    tagName: String(tag).toUpperCase(),
    children: [], childNodes: [],
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    style: new Proxy({}, { get(o, p) { return o[p] ?? ''; }, set(o, p, v) { o[p] = v; return true; } }),
    dataset: {},
    textContent: '', innerHTML: '', value: '', checked: false, disabled: false,
    width: 300, height: 150, clientWidth: 300, clientHeight: 150, offsetWidth: 300, offsetHeight: 150,
    firstChild: null, lastChild: null, parentElement: null,
    addEventListener() {}, removeEventListener() {},
    appendChild(c) { el.children.push(c); return c; },
    removeChild() {}, insertBefore() {}, replaceChildren() {},
    remove() {}, setAttribute() {}, getAttribute() { return null; }, removeAttribute() {},
    querySelector() { return makeEl('div'); },
    querySelectorAll() { return []; },
    closest() { return null; },
    getBoundingClientRect() { return { left: 0, top: 0, width: 300, height: 150, right: 300, bottom: 150 }; },
    getContext() { return makeCtx(el); },
    toDataURL() { return 'data:,'; },
    focus() {}, click() {}, blur() {}, scrollTo() {},
    animate() { return { finished: Promise.resolve(), cancel() {} }; },
    setProperty() {},
  };
  return el;
}

const doc = {
  body: makeEl('body'),
  documentElement: makeEl('html'),
  createElement: (t) => makeEl(t),
  createElementNS: (_ns, t) => makeEl(t),
  createTextNode: () => makeEl('text'),
  getElementById: () => makeEl('div'),
  querySelector: () => makeEl('div'),
  querySelectorAll: () => [],
  addEventListener() {}, removeEventListener() {},
  fonts: { ready: Promise.resolve() },
  hidden: false,
  visibilityState: 'visible',
};

const store = new Map();
const localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
};

const win = globalThis;
const def = (k, v) => Object.defineProperty(win, k, { value: v, configurable: true, writable: true });
win.window = win;
def('document', doc);
def('localStorage', localStorage);
def('navigator', { userAgent: 'node-smoke', clipboard: { writeText: async () => {} }, language: 'zh-CN' });
win.location = { search: '', hash: '', href: 'http://localhost/', pathname: '/' };
win.history = { replaceState() {}, pushState() {} };
win.devicePixelRatio = 1;
win.innerWidth = 1280; win.innerHeight = 800;
win.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
win.addEventListener = () => {};
win.removeEventListener = () => {};
win.scrollTo = () => {};
win.requestAnimationFrame = () => 1;
win.cancelAnimationFrame = () => {};
win.getComputedStyle = () => ({ getPropertyValue: () => '' });
win.ResizeObserver = class { observe() {} disconnect() {} };
win.CSS = { escape: (s) => String(s) };
win.URL.createObjectURL = () => 'blob:smoke';
win.URL.revokeObjectURL = () => {};
win.Image = class { set src(_) {} addEventListener() {} };

process.on('unhandledRejection', (e) => { console.error('unhandledRejection:', e); process.exit(1); });
process.on('uncaughtException', (e) => { console.error('uncaughtException:', e); process.exit(1); });

const entry = process.env.APP_ENTRY
  ? new URL(process.env.APP_ENTRY, import.meta.url).href
  : new URL('../src/app.js', import.meta.url).href;
await import(entry);
console.log('APP_SMOKE_OK');
setTimeout(() => process.exit(0), 60);
