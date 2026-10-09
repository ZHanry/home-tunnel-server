export function parseReleaseVersion(value: string) {
  const match =
    /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:RC([1-9]\d*)|rc\.([1-9]\d*)))?$/.exec(value);
  if (!match) return null;
  const parts = [match[1], match[2], match[3]].map(Number);
  const candidate = match[4] ?? match[5];
  if (parts.some((part) => !Number.isSafeInteger(part))) return null;
  const rc = candidate === undefined ? null : Number(candidate);
  if (rc !== null && !Number.isSafeInteger(rc)) return null;
  return { parts, rc };
}

export function compareReleaseVersions(a: string, b: string): number {
  const left = parseReleaseVersion(a),
    right = parseReleaseVersion(b);
  if (!left || !right) throw new Error("Unsupported release version");
  for (let index = 0; index < 3; index++) {
    const delta = left.parts[index]! - right.parts[index]!;
    if (delta) return Math.sign(delta);
  }
  if (left.rc === right.rc) return 0;
  if (left.rc === null) return 1;
  if (right.rc === null) return -1;
  return Math.sign(left.rc - right.rc);
}
