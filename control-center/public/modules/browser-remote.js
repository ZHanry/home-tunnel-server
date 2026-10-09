import { t } from "./locale.js?v=13.0.0";

// Signaling and authorization use HTTPS. Screen and input travel only over peer DTLS/SCTP.
export function createBrowserRemote({ api, escapeHtml }) {
  const sessions = new Set();
  async function connect(targetId, password = "") {
    const dialog = document.createElement("dialog");
    dialog.className = "browser-remote-dialog";
    dialog.innerHTML = `<header><div><strong>${t("远程控制", "Remote control")}</strong><span data-remote-target>${escapeHtml(targetId)}</span></div><div class="browser-remote-tools"><button type="button" data-fullscreen aria-label="${t("全屏", "Fullscreen")}">⛶</button><button type="button" data-close aria-label="${t("结束连接", "End connection")}">×</button></div></header><div class="browser-remote-stage"><canvas tabindex="0" aria-label="${t("远程设备画面，点击后可使用键盘和鼠标", "Remote screen. Click to use the keyboard and pointer")}"></canvas><p data-remote-status role="status">${t("等待被控设备批准…", "Waiting for the host to approve…")}</p></div><footer><span data-remote-path>${t("正在建立安全直连", "Establishing a secure direct connection")}</span><span>${t("按 Esc 退出全屏", "Press Esc to leave fullscreen")}</span></footer>`;
    document.body.append(dialog); dialog.showModal();
    const canvas = dialog.querySelector("canvas"), context = canvas.getContext("2d", { alpha: false });
    const status = dialog.querySelector("[data-remote-status]");
    const pc = new RTCPeerConnection({ iceServers: [], bundlePolicy: "max-bundle" });
    const frames = pc.createDataChannel("nestlink.frames.v1", { ordered: false, maxRetransmits: 0 });
    const input = pc.createDataChannel("nestlink.input.v1", { ordered: true });
    frames.binaryType = "arraybuffer";
    let id = "", closed = false, drawing = false, authorized = false, heartbeat, timeout, watchdog;
    let lastFrame = performance.now(), newest = -1, pointerFrame = 0, pendingPointer;
    const assembled = new Map();
    const current = { close };
    sessions.add(current);
    function send(value) {
      if (!closed && authorized && input.readyState === "open" && input.bufferedAmount < 65536)
        input.send(JSON.stringify(value));
    }
    function fail(message) {
      if (closed) return;
      status.textContent = message; status.hidden = false;
      void close(false);
    }
    function close(remove = true) {
      if (!closed) {
        closed = true; clearInterval(heartbeat); clearTimeout(timeout); clearInterval(watchdog);
        assembled.clear(); pc.close();
        cancelAnimationFrame(pointerFrame);
        if (id) void api(`/api/v2/browser/sessions/${id}`, { method: "DELETE" }).catch(() => {});
      }
      if (remove) { sessions.delete(current); dialog.close(); dialog.remove(); }
    }
    dialog.querySelector("[data-close]").onclick = () => void close();
    dialog.addEventListener("cancel", event => { event.preventDefault(); void close(); });
    dialog.querySelector("[data-fullscreen]").onclick = () => {
      if (document.fullscreenElement) void document.exitFullscreen(); else void dialog.requestFullscreen();
    };
    const position = event => {
      const r = canvas.getBoundingClientRect();
      return { x: Math.max(0, Math.min(1, (event.clientX - r.left) / r.width)), y: Math.max(0, Math.min(1, (event.clientY - r.top) / r.height)) };
    };
    canvas.addEventListener("pointermove", event => {
      pendingPointer = position(event);
      if (!pointerFrame) pointerFrame = requestAnimationFrame(() => {
        pointerFrame = 0; send({ kind: "move", ...pendingPointer });
      });
    });
    canvas.addEventListener("pointerdown", event => {
      event.preventDefault(); canvas.focus(); canvas.setPointerCapture(event.pointerId);
      send({ kind: "move", ...position(event) }); send({ kind: "button", button: event.button, down: true });
    });
    canvas.addEventListener("pointerup", event => { event.preventDefault(); send({ kind: "button", button: event.button, down: false }); });
    canvas.addEventListener("pointercancel", () => send({ kind: "release" }));
    canvas.addEventListener("contextmenu", event => event.preventDefault());
    canvas.addEventListener("wheel", event => { event.preventDefault(); send({ kind: "wheel", x: Math.sign(event.deltaX) * Math.min(5, Math.ceil(Math.abs(event.deltaX) / 100)), y: Math.sign(event.deltaY) * Math.min(5, Math.ceil(Math.abs(event.deltaY) / 100)) }); }, { passive: false });
    for (const type of ["keydown", "keyup"]) canvas.addEventListener(type, event => {
      if (event.isComposing || event.repeat) return;
      event.preventDefault(); send({ kind: "key", key: event.code, down: type === "keydown" });
    });
    canvas.addEventListener("blur", () => send({ kind: "release" }));
    canvas.addEventListener("paste", event => { event.preventDefault(); send({ kind: "text", text: event.clipboardData.getData("text/plain").slice(0, 2048) }); });
    canvas.addEventListener("compositionend", event => send({ kind: "text", text: event.data.slice(0, 2048) }));
    async function directPair() {
      const stats = await pc.getStats();
      const values = [...stats.values()];
      const transport = values.find(value => value.type === "transport" && value.selectedCandidatePairId);
      const pair = transport ? stats.get(transport.selectedCandidatePairId) : values.find(value => value.type === "candidate-pair" && value.nominated && value.state === "succeeded");
      if (!pair) return false;
      return [stats.get(pair.localCandidateId), stats.get(pair.remoteCandidateId)].every(candidate =>
        candidate?.protocol === "udp" && ["host", "srflx", "prflx"].includes(candidate.candidateType) && !candidate.tcpType);
    }
    frames.onmessage = async event => {
      if (closed || !authorized || !(event.data instanceof ArrayBuffer) || event.data.byteLength < 16 || event.data.byteLength > 16400) return;
      const bytes = new Uint8Array(event.data), header = new DataView(event.data);
      if (header.getUint32(0) !== 0x4e4c4a31) return;
      const frameId = header.getUint32(4), index = header.getUint16(8), count = header.getUint16(10), length = header.getUint32(12);
      if (frameId <= newest || count < 1 || count > 128 || index >= count || length > 2097152 || !length) return;
      if (!assembled.has(frameId)) {
        if (assembled.size >= 3) assembled.delete(assembled.keys().next().value);
        assembled.set(frameId, { count, length, chunks: new Map(), created: performance.now() });
      }
      const frame = assembled.get(frameId);
      if (frame.count !== count || frame.length !== length || performance.now() - frame.created > 1500) { assembled.delete(frameId); return; }
      frame.chunks.set(index, bytes.slice(16));
      if (frame.chunks.size !== count || drawing) return;
      drawing = true;
      try {
        const image = new Uint8Array(length); let offset = 0;
        for (let part = 0; part < count; part++) {
          const chunk = frame.chunks.get(part); if (offset + chunk.length > length) throw new Error("frame");
          image.set(chunk, offset); offset += chunk.length;
        }
        if (offset !== length || image[0] !== 0xff || image[1] !== 0xd8) throw new Error("frame");
        const bitmap = await createImageBitmap(new Blob([image], { type: "image/jpeg" }));
        if (bitmap.width > 1920 || bitmap.height > 1080) { bitmap.close(); throw new Error("frame"); }
        if (!closed && frameId > newest) {
          canvas.width = bitmap.width; canvas.height = bitmap.height;
          context.drawImage(bitmap, 0, 0); newest = frameId; lastFrame = performance.now();
          status.hidden = true; clearTimeout(timeout);
          dialog.querySelector("[data-remote-path]").textContent = t("P2P 直连 · 已加密", "Direct P2P · Encrypted");
        }
        bitmap.close();
      } catch { fail(t("画面数据无效，连接已结束", "Invalid screen data. Connection ended")); }
      finally { assembled.delete(frameId); drawing = false; }
    };
    pc.onconnectionstatechange = async () => {
      if (closed) return;
      if (pc.connectionState === "connected") {
        if (!await directPair()) { fail(t("未建立安全直连，连接已结束", "A secure direct path could not be established")); return; }
        authorized = true; status.textContent = t("正在获取画面…", "Loading the remote screen…");
      } else if (["failed", "disconnected"].includes(pc.connectionState)) fail(t("直连中断，请重新连接", "The direct connection ended. Connect again"));
    };
    timeout = setTimeout(() => fail(t("连接超时，请确认对方在线并允许连接", "Connection timed out. Check that the host is online and approves the request")), 30000);
    watchdog = setInterval(() => {
      if (authorized && performance.now() - lastFrame > 10000) fail(t("画面传输中断，连接已结束", "Screen transmission stopped. Connection ended"));
      send({ kind: "heartbeat" });
    }, 1000);
    try {
      const configuration = await api("/api/v2/browser/config");
      if (closed) return;
      pc.setConfiguration({ iceServers: configuration.ice_servers, bundlePolicy: "max-bundle" });
      await pc.setLocalDescription(await pc.createOffer());
      if (pc.iceGatheringState !== "complete") await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(t("无法获取直连地址", "Unable to obtain a direct address"))), 8000);
        pc.addEventListener("icegatheringstatechange", () => { if (pc.iceGatheringState === "complete") { clearTimeout(timer); resolve(); } });
      });
      if (closed) return;
      const created = await api("/api/v2/browser/sessions", { method: "POST", body: JSON.stringify({ target_id: targetId, offer: pc.localDescription.sdp, password }) });
      password = ""; id = created.session_id;
      if (closed) { await api(`/api/v2/browser/sessions/${id}`, { method: "DELETE" }); return; }
      let busy = false;
      const poll = async () => {
        if (busy || closed) return; busy = true;
        try {
          const session = await api(`/api/v2/browser/sessions/${id}/heartbeat`, { method: "POST", body: "{}" });
          if (closed) return;
          if (session.state === "closed") { fail(t("对方拒绝或结束了连接", "The host declined or ended the connection")); return; }
          if (session.state === "active" && !pc.remoteDescription) await pc.setRemoteDescription({ type: "answer", sdp: session.answer });
        } catch (error) { fail(error.message); }
        finally { busy = false; }
      };
      heartbeat = setInterval(() => void poll(), 2000); await poll();
    } catch (error) { fail(error.message); }
  }
  function request(targetId) {
    const dialog = document.createElement("dialog");
    dialog.className = "modal browser-remote-request";
    dialog.innerHTML = `<form class="form-stack"><h2>${t("连接设备", "Connect to a device")}</h2><p data-no-translate>${escapeHtml(targetId)}</p><div class="field"><label for="browser-optional-password">${t("远控密码", "Remote password")}</label><input id="browser-optional-password" name="password" type="password" maxlength="128" autocomplete="off" placeholder="${t("可留空，由对方批准", "Optional; the host can approve")}"></div><div class="form-actions"><button class="button button-secondary" type="button" data-cancel>${t("取消", "Cancel")}</button><button class="button button-primary" type="submit">${t("发起连接", "Connect")}</button></div></form>`;
    const current = { close: () => { sessions.delete(current); dialog.close(); dialog.remove(); } };
    sessions.add(current); document.body.append(dialog); dialog.showModal();
    dialog.querySelector("[data-cancel]").onclick = current.close;
    dialog.addEventListener("cancel", event => { event.preventDefault(); current.close(); });
    dialog.querySelector("form").onsubmit = event => {
      event.preventDefault(); const password = new FormData(event.currentTarget).get("password");
      current.close(); void connect(targetId, password);
    };
  }
  return { connect, request, closeAll: () => { for (const session of [...sessions]) session.close(); } };
}
