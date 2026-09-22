import { TYPES, uuidBytes } from "./protocol.js";
import { RemoteError } from "./http.js";

const usages = new Map([
  ["Enter", 40], ["Escape", 41], ["Backspace", 42], ["Tab", 43], ["Space", 44],
  ["Minus", 45], ["Equal", 46], ["BracketLeft", 47], ["BracketRight", 48], ["Backslash", 49],
  ["Semicolon", 51], ["Quote", 52], ["Backquote", 53], ["Comma", 54], ["Period", 55], ["Slash", 56],
  ["CapsLock", 57], ["PrintScreen", 70], ["ScrollLock", 71], ["Pause", 72], ["Insert", 73],
  ["Home", 74], ["PageUp", 75], ["Delete", 76], ["End", 77], ["PageDown", 78],
  ["ArrowRight", 79], ["ArrowLeft", 80], ["ArrowDown", 81], ["ArrowUp", 82], ["NumLock", 83],
  ["NumpadDivide", 84], ["NumpadMultiply", 85], ["NumpadSubtract", 86], ["NumpadAdd", 87], ["NumpadEnter", 88],
  ["Numpad0", 98], ["NumpadDecimal", 99], ["IntlBackslash", 100], ["ContextMenu", 101],
  ["ControlLeft", 224], ["ShiftLeft", 225], ["AltLeft", 226], ["MetaLeft", 227],
  ["ControlRight", 228], ["ShiftRight", 229], ["AltRight", 230], ["MetaRight", 231],
]);
for (let n = 0; n < 26; n++) usages.set(`Key${String.fromCharCode(65 + n)}`, 4 + n);
for (let n = 1; n <= 9; n++) { usages.set(`Digit${n}`, 29 + n); usages.set(`Numpad${n}`, 88 + n); }
usages.set("Digit0", 39);
for (let n = 1; n <= 12; n++) usages.set(`F${n}`, 57 + n);
export const keyUsage = (code) => usages.get(code);

export function pointerCoordinates(rect, width, height, x, y) {
  if (!(width > 0 && height > 0 && rect.width > 0 && rect.height > 0) || ![x, y].every(Number.isFinite)) return null;
  const ratio = Math.min(rect.width / width, rect.height / height);
  const left = rect.left + (rect.width - width * ratio) / 2, top = rect.top + (rect.height - height * ratio) / 2;
  const pixelX = (x - left) / ratio, pixelY = (y - top) / ratio;
  if (pixelX < 0 || pixelY < 0 || pixelX >= width || pixelY >= height) return null;
  return { x: Math.min(65535, Math.round(pixelX / Math.max(1, width - 1) * 65535)), y: Math.min(65535, Math.round(pixelY / Math.max(1, height - 1) * 65535)) };
}

export class RemoteInput {
  constructor(session, video) {
    this.session = session; this.video = video; this.keys = new Set(); this.buttons = 0; this.motion = 0; this.pendingText = new Map();
    this.abort = new AbortController(); video.tabIndex = 0;
    session.inputState = () => ({ keys: [...this.keys].map((usage) => ({ usage_page: 7, usage })), buttons: this.buttons });
    session.clearInputState = () => { this.keys.clear(); this.buttons = 0; this.cancelText(); };
    session.onTextAck = (frame) => this.acknowledgeText(frame);
    const on = (name, callback, target = video) => target.addEventListener(name, callback, { signal: this.abort.signal, passive: false });
    on("keydown", (event) => this.key(event, true)); on("keyup", (event) => this.key(event, false));
    on("pointermove", (event) => this.pointer(event));
    on("pointerdown", (event) => this.button(event, true)); on("pointerup", (event) => this.button(event, false));
    on("wheel", (event) => this.wheel(event)); on("contextmenu", (event) => { if (session.inputEnabled) event.preventDefault(); });
    on("blur", () => this.release()); on("pointercancel", () => this.release());
    on("lostpointercapture", () => { if (this.buttons) this.release(); });
  }
  allowed(permission) { return this.session.inputEnabled && this.session.permissions.has(permission) && document.activeElement === this.video && !document.hidden; }
  key(event, down) {
    if (!this.allowed("input.keyboard") || event.isComposing || event.keyCode === 229) return;
    const usage = keyUsage(event.code); if (!usage) return;
    event.preventDefault();
    if (!down && !this.keys.has(usage)) return;
    const payload = new Uint8Array(8), view = new DataView(payload.buffer);
    view.setUint16(0, 7); view.setUint16(2, usage); view.setUint8(4, down ? 1 : 0); view.setUint8(5, down && event.repeat ? 1 : 0);
    this.session.send(TYPES.KEY, payload);
    if (down) this.keys.add(usage); else this.keys.delete(usage);
  }
  position(event) {
    if (!this.allowed("input.pointer")) return null;
    const layout = this.session.layout;
    const display = layout?.displays.find((item) => item.id === layout.active_display);
    if (!display || !Number.isInteger(display.slot) || display.slot < 0 || display.slot > 65535) return null;
    const point = pointerCoordinates(this.video.getBoundingClientRect(), this.video.videoWidth, this.video.videoHeight, event.clientX, event.clientY);
    return point ? { ...point, slot: display.slot, epoch: layout.layout_epoch } : null;
  }
  pointer(event) {
    const point = this.position(event); if (!point) return;
    event.preventDefault();
    const channel = this.session.channels.get("motion");
    if (channel?.bufferedAmount > 1024) return;
    const payload = new Uint8Array(16), view = new DataView(payload.buffer);
    view.setUint32(0, point.epoch); view.setUint16(4, point.slot); view.setUint16(6, point.x); view.setUint16(8, point.y); view.setUint32(12, ++this.motion);
    this.session.send(TYPES.POINTER_ABS, payload);
  }
  button(event, down) {
    if (down) this.video.focus();
    const point = this.position(event);
    if (!point) { if (!down && this.buttons) this.release(); return; }
    const button = [1, 3, 2, 4, 5][event.button]; if (!button) return;
    event.preventDefault();
    const payload = new Uint8Array(32), view = new DataView(payload.buffer);
    view.setUint32(0, point.epoch); view.setUint16(4, point.slot); view.setUint16(6, point.x); view.setUint16(8, point.y);
    view.setUint8(10, button); view.setUint8(11, down ? 1 : 0); view.setUint32(12, ++this.motion);
    this.session.send(TYPES.BUTTON, payload);
    if (down) { this.buttons |= 1 << (button - 1); this.video.setPointerCapture(event.pointerId); }
    else this.buttons &= ~(1 << (button - 1));
  }
  wheel(event) {
    const point = this.position(event); if (!point) return;
    event.preventDefault();
    const unit = event.deltaMode === 0 ? 1.2 : event.deltaMode === 1 ? 40 : 360;
    const clamp = (value) => Math.max(-12000, Math.min(12000, Math.round(value * unit)));
    const payload = new Uint8Array(24), view = new DataView(payload.buffer);
    view.setUint32(0, point.epoch); view.setUint16(4, point.slot); view.setUint16(6, point.x); view.setUint16(8, point.y);
    view.setInt32(12, clamp(event.deltaX)); view.setInt32(16, clamp(event.deltaY)); view.setUint32(20, ++this.motion);
    this.session.send(TYPES.WHEEL, payload);
  }
  submitText(text) {
    if (!this.session.inputEnabled || !this.session.permissions.has("input.text") || document.hidden) throw new RemoteError("RD_INPUT_DENIED");
    if (this.pendingText.size) throw new RemoteError("RD_TEXT_PENDING");
    if (typeof text !== "string" || !text.isWellFormed()) throw new Error("RD_INVALID_TEXT");
    const content = new TextEncoder().encode(text);
    if (!content.length || content.length > 4096) throw new Error("RD_TEXT_TOO_LARGE");
    const id = crypto.randomUUID(), payload = new Uint8Array(20 + content.length);
    payload.set(uuidBytes(id)); new DataView(payload.buffer).setUint32(16, content.length); payload.set(content, 20);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pendingText.delete(id); reject(new RemoteError("RD_TEXT_UNCONFIRMED")); }, 5000);
      this.pendingText.set(id, { epoch: this.session.inputEpoch, timer, resolve, reject });
      try { this.session.send(TYPES.TEXT_COMMIT, payload); }
      catch (error) { clearTimeout(timer); this.pendingText.delete(id); reject(error); }
    });
  }
  acknowledgeText(frame) {
    if (frame.type !== TYPES.TEXT_ACK || !(frame.payload instanceof Uint8Array) || frame.payload.length !== 18) return;
    const hex = Array.from(frame.payload.subarray(0, 16), (byte) => byte.toString(16).padStart(2, "0")).join("");
    const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    const pending = this.pendingText.get(id);
    if (!pending || pending.epoch !== frame.inputEpoch || frame.inputEpoch !== this.session.inputEpoch) return;
    clearTimeout(pending.timer); this.pendingText.delete(id);
    const status = new DataView(frame.payload.buffer, frame.payload.byteOffset, frame.payload.byteLength).getUint16(16);
    if (status === 0) pending.resolve(id); else pending.reject(new RemoteError("RD_TEXT_REJECTED"));
  }
  async submitTextOnce(text) {
    const { inputEpoch, inputRequestId } = this.session;
    try { return await this.submitText(text); }
    finally {
      if (this.session.inputEpoch === inputEpoch && this.session.inputRequestId === inputRequestId) this.release();
    }
  }
  cancelText() {
    for (const pending of this.pendingText.values()) { clearTimeout(pending.timer); pending.reject(new RemoteError("RD_TEXT_UNCONFIRMED")); }
    this.pendingText.clear();
  }
  release() { this.session.releaseInput(); this.keys.clear(); this.buttons = 0; }
  close() { this.release(); this.abort.abort(); this.session.inputState = undefined; this.session.clearInputState = undefined; this.session.onTextAck = undefined; }
}
