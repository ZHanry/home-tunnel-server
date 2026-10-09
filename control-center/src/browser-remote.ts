import { createHash } from "node:crypto";
import { HttpError } from "./http.js";

export function browserSdp(value: string): string {
  if (
    value.length > 32768 ||
    !value.startsWith("v=0") ||
    !/^a=fingerprint:sha-256 (?:[A-Fa-f0-9]{2}:){31}[A-Fa-f0-9]{2}\r?$/m.test(value) ||
    !/^m=application \d+ UDP\/DTLS\/SCTP /m.test(value) ||
    !/^a=ice-ufrag:[A-Za-z0-9+/]{4,128}\r?$/m.test(value) ||
    !/^a=ice-pwd:[A-Za-z0-9+/]{22,256}\r?$/m.test(value) ||
    (value.match(/^m=/gm)?.length ?? 0) !== 1 ||
    /^m=(?:video|audio)/m.test(value)
  )
    throw new HttpError(400, "BROWSER_SDP_INVALID", "连接信息无效，请重新发起连接");
  for (const line of value.split(/\r?\n/)) {
    if (!line.startsWith("a=candidate:")) continue;
    const fields = line.split(/\s+/);
    if (
      fields.length < 8 ||
      fields[2]?.toLowerCase() !== "udp" ||
      fields[6] !== "typ" ||
      !["host", "srflx", "prflx"].includes(fields[7]!) ||
      /\btcp(?:type)?\b/i.test(line)
    )
      throw new HttpError(400, "BROWSER_DIRECT_REQUIRED", "远控仅支持加密 UDP 直连");
  }
  return value;
}

export function browserSdpDigest(value: string) {
  return createHash("sha256").update(value).digest("hex");
}
