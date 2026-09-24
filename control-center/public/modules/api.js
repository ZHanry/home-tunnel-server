import { localizedApiError } from "./locale.js?v=9.0.0";
import { state } from "./state.js?v=9.0.0";

let refreshInFlight = null;
const sessionChannel = typeof window.BroadcastChannel === "function"
  ? new window.BroadcastChannel("home-tunnel-session") : null;
if (sessionChannel) sessionChannel.onmessage = ({ data }) => {
  if (data?.type === "csrf" && typeof data.value === "string") state.csrf = data.value;
};

export class ApiError extends Error {
  constructor(message, code, status = 0, details = {}) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

async function request(path, options) {
  try {
    const timeout = AbortSignal.timeout(20_000);
    return await fetch(path, {
      ...options,
      signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
    });
  } catch (error) {
    if (options.signal?.aborted) throw error;
    throw new ApiError(
      error.name === "TimeoutError"
        ? "请求超时，请检查网络后重试"
        : "无法连接服务器，请检查网络后重试",
      "NETWORK_UNAVAILABLE",
    );
  }
}

async function parseResponse(response) {
  if (response.status === 204) return null;
  const type = response.headers.get("content-type") ?? "";
  return type.includes("application/json") ? response.json() : response.text();
}

async function performSessionRefresh() {
  // An authenticated read restores per-session CSRF after reload and lets a
  // waiting tab reuse cookies already refreshed by another tab.
  const existing = await request("/api/v1/auth/session", { credentials: "same-origin" });
  if (existing.ok) {
    const data = await existing.json();
    state.csrf = data.csrf_token;
    sessionChannel?.postMessage({ type: "csrf", value: state.csrf });
    return data;
  }
  if (existing.status !== 401) throw new ApiError("暂时无法验证会话，请稍后重试", "SERVICE_UNAVAILABLE", existing.status);
  const response = await request("/api/v1/auth/refresh", {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_type: "web" }),
  });
  if (response.status === 401 || response.status === 403)
    throw new ApiError("会话已失效，请重新登录", "SESSION_REVOKED", response.status);
  if (!response.ok)
    throw new ApiError("暂时无法验证会话，请稍后重试", "SERVICE_UNAVAILABLE", response.status);
  const data = await response.json();
  state.csrf = data.csrf_token;
  sessionChannel?.postMessage({ type: "csrf", value: state.csrf });
  return data;
}

export function refreshSession() {
  if (!refreshInFlight) {
    const refresh = () => performSessionRefresh();
    const operation = globalThis.navigator?.locks
      ? globalThis.navigator.locks.request("home-tunnel-session-refresh", refresh) : refresh();
    refreshInFlight = operation.finally(() => {
      refreshInFlight = null;
    });
  }
  return refreshInFlight;
}

export async function api(path, options = {}, canRefresh = true) {
  const method = options.method ?? "GET";
  const headers = new Headers(options.headers ?? {});
  if (options.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  if (!["GET", "HEAD", "OPTIONS"].includes(method) && state.csrf)
    headers.set("x-csrf-token", state.csrf);
  headers.set("x-request-id", crypto.randomUUID());
  const response = await request(path, { ...options, method, headers, credentials: "same-origin" });
  const data = await parseResponse(response);
  const sessionFailure = response.status === 401 && ["SESSION_REVOKED", "AUTH_REQUIRED"].includes(data?.error_code);
  const staleCsrf = response.status === 403 && data?.error_code === "CSRF_INVALID";
  if (canRefresh && (sessionFailure || staleCsrf) && !["/api/v1/auth/refresh", "/api/v1/auth/session", "/api/v1/auth/login", "/api/v1/auth/device", "/api/v1/auth/enroll"].includes(path)) {
    try {
      await refreshSession();
    } catch (error) {
      if (error.code === "SESSION_REVOKED" && window.dispatchEvent)
        window.dispatchEvent(new CustomEvent("session-expired"));
      throw error;
    }
    return api(path, options, false);
  }
  if (!response.ok) {
    const reauthFailure = path === "/api/v1/rd/reauth" &&
      ["AUTH_INVALID", "MFA_REQUIRED", "MFA_INVALID"].includes(data?.error_code);
    const code =
      response.status === 401 && !path.startsWith("/api/v1/auth/") && !reauthFailure
        ? "SESSION_REVOKED"
        : data?.error_code;
    if (code === "SESSION_REVOKED" && window.dispatchEvent)
      window.dispatchEvent(new CustomEvent("session-expired"));
    throw new ApiError(localizedApiError(data, response.status), code, response.status, data);
  }
  return data;
}

// Used for bounded selectors and dashboard aggregates; list views render pages.
export async function allPages(path) {
  const url=new URL(path,window.location.origin);
  const items=[]; let first;
  for(let page=1;page<=100;page++) {
    url.searchParams.set("page",String(page));url.searchParams.set("page_size","100");
    const response=await api(url.pathname+url.search);
    first??=response;items.push(...response.items);
    if(page>=Number(response.total_pages??1))return {...first,items:[...new Map(items.map(item=>[item.id,item])).values()]};
  }
  throw new ApiError("列表超过 100 页，请使用筛选条件","RESOURCE_LIMIT");
}
