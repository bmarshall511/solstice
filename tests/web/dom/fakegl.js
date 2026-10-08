// A stand-in for THREE.WebGLRenderer under happy-dom (no WebGL there). The scenes build their real three.js scene graphs, cameras
// and materials; only the GPU calls are no-ops. Anything the scenes read or call that isn't listed here is a no-op function, so a
// scene that starts using a new renderer method keeps running instead of crashing the test (the call is recorded in `calls`).
// No three.js import here: tests/web/dom/three.js mixes this into the real module.
export class FakeRenderer {
  constructor(opts = {}) {
    this.domElement = opts.canvas ?? document.createElement('canvas');
    this.shadowMap = { enabled: false, type: 0, autoUpdate: true, needsUpdate: false };
    this.info = { render: { calls: 0, triangles: 0 }, memory: {}, reset() {} };
    this.capabilities = { isWebGL2: true, maxTextures: 16, getMaxAnisotropy: () => 1 };
    this.toneMapping = 0; this.toneMappingExposure = 1; this.outputColorSpace = 'srgb';
    this.autoClear = true; this.localClippingEnabled = false;
    this.calls = []; this.renders = 0; this.disposed = false;
    this._w = 300; this._h = 150; this._pr = 1;
    FakeRenderer.instances.push(this);
    return new Proxy(this, { get: (t, k) => (k in t ? t[k] : typeof k === 'string' ? (...a) => { t.calls.push(k); return undefined; } : undefined) });
  }
  setSize(w, h) { this._w = w; this._h = h; }
  getSize(v) { return v?.set ? v.set(this._w, this._h) : { x: this._w, y: this._h }; }
  setPixelRatio(r) { this._pr = r; }
  getPixelRatio() { return this._pr; }
  setClearColor() {}
  getClearColor(c) { return c; }
  setClearAlpha() {}
  render() { this.renders++; }
  dispose() { this.disposed = true; }
  forceContextLoss() {}
  getContext() { return { getExtension: () => null, getParameter: () => 0 }; }
  setAnimationLoop() {}
  compile() {}
  clear() {}
  setRenderTarget() {}
  setScissorTest() {}
  setScissor() {}
  setViewport() {}
}
FakeRenderer.instances = [];
