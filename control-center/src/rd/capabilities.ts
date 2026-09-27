import { z } from "zod";
import { HttpError } from "../http.js";

export const permissions = [
  "view",
  "input.keyboard",
  "input.pointer",
  "input.text",
  "audio.system",
  "audio.microphone",
  "clipboard.read",
  "clipboard.write",
  "files.send",
  "files.receive",
] as const;
export type Permission = (typeof permissions)[number];

export const availabilityValues = [
  "available",
  "unavailable",
  "permission_required",
  "unsupported",
] as const;
export type Availability = (typeof availabilityValues)[number];

export const backendKeys = [
  "capture",
  "input_keyboard",
  "input_pointer",
  "input_text",
  "system_audio",
  "microphone",
  "clipboard",
  "files",
  "secure_desktop",
] as const;
export type BackendKey = (typeof backendKeys)[number];

const permissionBackends: Record<Permission, BackendKey> = {
  view: "capture",
  "input.keyboard": "input_keyboard",
  "input.pointer": "input_pointer",
  "input.text": "input_text",
  "audio.system": "system_audio",
  "audio.microphone": "microphone",
  "clipboard.read": "clipboard",
  "clipboard.write": "clipboard",
  "files.send": "files",
  "files.receive": "files",
};

const discoveredFeatures = new Set<Permission>([
  "audio.system",
  "audio.microphone",
  "files.send",
  "files.receive",
]);

const displaySchema = z.strictObject({
  id: z.string().min(1).max(128),
  name: z.string().max(128),
  width: z.number().int().min(1).max(32768),
  height: z.number().int().min(1).max(32768),
  slot: z.number().int().min(0).max(65535).optional(),
  width_px: z.number().int().min(1).max(32768).optional(),
  height_px: z.number().int().min(1).max(32768).optional(),
  dpi_x: z.number().int().min(1).max(960).optional(),
  dpi_y: z.number().int().min(1).max(960).optional(),
  scale_percent: z.number().int().min(100).max(500).optional(),
  origin_x: z.number().int().min(-100000).max(100000).optional(),
  origin_y: z.number().int().min(-100000).max(100000).optional(),
});

const nativeSchema = z.strictObject({
  schema: z.literal(1),
  reporter: z.enum(["agent", "controller", "browser"]),
  backends: z.strictObject({
    capture: z.enum(availabilityValues),
    input_keyboard: z.enum(availabilityValues),
    input_pointer: z.enum(availabilityValues),
    input_text: z.enum(availabilityValues),
    system_audio: z.enum(availabilityValues),
    microphone: z.enum(availabilityValues),
    clipboard: z.enum(availabilityValues),
    files: z.enum(availabilityValues),
    secure_desktop: z.enum(availabilityValues),
  }),
});

export const capabilitySchema = z.strictObject({
  permissions: z
    .array(z.enum(permissions))
    .min(1)
    .max(permissions.length)
    .refine((values) => new Set(values).size === values.length && values.includes("view")),
  unattended_enabled: z.boolean().default(false),
  displays: z.array(displaySchema).max(16).default([]),
  codecs: z
    .array(z.enum(["H264", "VP8", "AV1", "HEVC"]))
    .max(4)
    .default([]),
  status: z.enum(["ready", "locked", "permission_required", "unavailable"]).default("ready"),
  native: nativeSchema.optional(),
});

export type CapabilityReport = z.infer<typeof capabilitySchema>;
export type DisplayMetric = z.infer<typeof displaySchema>;

export function agentNative(
  overrides: Partial<Record<BackendKey, Availability>> = {},
): NonNullable<CapabilityReport["native"]> {
  return {
    schema: 1,
    reporter: "agent",
    backends: {
      capture: "available",
      input_keyboard: "available",
      input_pointer: "available",
      input_text: "available",
      system_audio: "available",
      microphone: "available",
      clipboard: "available",
      files: "available",
      secure_desktop: "unavailable",
      ...overrides,
    },
  };
}

function reject(message: string): never {
  throw new HttpError(422, "RD_CAPABILITY_UNSUPPORTED", message);
}

function scaleMatches(dpi: number, scalePercent: number) {
  return Math.round((dpi / 96) * 100) === scalePercent;
}

export function assertCapabilityReport(
  endpoint: { kind: string; role: string },
  capabilities: CapabilityReport,
) {
  const ids = new Set<string>();
  for (const display of capabilities.displays) {
    if (ids.has(display.id)) reject("显示器标识重复");
    ids.add(display.id);
    if (display.width_px !== undefined && display.width_px !== display.width)
      reject("显示器宽度与像素宽度不一致");
    if (display.height_px !== undefined && display.height_px !== display.height)
      reject("显示器高度与像素高度不一致");
    if (
      display.scale_percent !== undefined &&
      display.dpi_x !== undefined &&
      !scaleMatches(display.dpi_x, display.scale_percent)
    )
      reject("显示器 DPI 与缩放比例不一致");
    if (
      display.scale_percent !== undefined &&
      display.dpi_x === undefined &&
      display.dpi_y !== undefined &&
      !scaleMatches(display.dpi_y, display.scale_percent)
    )
      reject("显示器 DPI 与缩放比例不一致");
  }
  const native = capabilities.native;
  if (!native) return;
  const desktopHost = endpoint.kind === "desktop" && endpoint.role !== "controller";
  const hostedAvailable = (["capture", "system_audio", "microphone", "files"] as const).some(
    (key) => native.backends[key] === "available",
  );
  if (desktopHost && hostedAvailable && native.reporter !== "agent")
    reject("桌面被控能力必须由本机代理发现");
  if (native.reporter !== "agent" && native.backends.secure_desktop === "available")
    reject("安全桌面能力必须由本机代理发现");
  for (const permission of capabilities.permissions) {
    const backend = permissionBackends[permission];
    if (native.backends[backend] !== "available") reject("声明的权限没有对应的本机能力");
  }
}

export function assertSessionFeatures(
  capabilities: CapabilityReport,
  requested: readonly string[],
) {
  for (const permission of requested) {
    if (!discoveredFeatures.has(permission as Permission)) continue;
    const backend = permissionBackends[permission as Permission];
    if (capabilities.native?.backends[backend] !== "available")
      reject("该功能没有被本机工作进程发现");
  }
}

export const displayMetricKeys = [
  "id",
  "name",
  "width",
  "height",
  "slot",
  "width_px",
  "height_px",
  "dpi_x",
  "dpi_y",
  "scale_percent",
  "origin_x",
  "origin_y",
] as const;

export function publicDisplay(value: Record<string, unknown> | undefined) {
  if (!value || typeof value.id !== "string") return null;
  const display: Record<string, unknown> = {};
  for (const key of displayMetricKeys) if (value[key] !== undefined) display[key] = value[key];
  return display;
}
