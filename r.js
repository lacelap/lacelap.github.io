// Lacelap share-link codec (decoder) and route helpers.
//
// Mirrors ShareLinkCodec.decode in RouteEngine/Sources/RouteEngine/ShareLink.swift exactly.
// Both are checked against web/tests/sharelink-vectors.json, so they can't drift apart.
//
// Format v1: version byte, varint name length, UTF-8 name, varint meters, varint point count,
// then zigzag-varint lat/lon at 1e-5° (first absolute, rest deltas). Base64url, padding optional.

export const VERSION = 1;
const SCALE = 1e5;
const MAX_LAT = 90n * 100000n;
const MAX_LON = 180n * 100000n;
const MASK64 = (1n << 64n) - 1n;
const EARTH_RADIUS = 6371008.8;

/** Error codes match ShareLinkError cases in Swift. */
export class ShareLinkError extends Error {
  /**
   * @param {"invalidBase64"|"unsupportedVersion"|"truncated"|"invalidRoute"} code
   * @param {number} [version]
   */
  constructor(code, version) {
    super(code === "unsupportedVersion" ? `unsupported share link version ${version}` : code);
    this.name = "ShareLinkError";
    this.code = code;
    if (version !== undefined) this.version = version;
  }
}

// Foundation's Data(base64Encoded:) with default options: standard alphabet, padded to a
// multiple of 4, padding only at the end, no whitespace.
const STRICT_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function fromBase64url(s) {
  let b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  b64 += "=".repeat((4 - (b64.length % 4)) % 4);
  if (!STRICT_BASE64.test(b64)) return null;
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

class ByteReader {
  constructor(bytes) {
    this.bytes = bytes;
    this.offset = 0;
  }

  byte() {
    if (this.offset >= this.bytes.length) throw new ShareLinkError("truncated");
    return this.bytes[this.offset++];
  }

  take(n) {
    if (n < 0 || this.offset + n > this.bytes.length) throw new ShareLinkError("truncated");
    const out = this.bytes.subarray(this.offset, this.offset + n);
    this.offset += n;
    return out;
  }

  /** A varint used as a byte length or element count: can't exceed what's left. */
  length() {
    const n = this.varint();
    if (n > BigInt(this.bytes.length - this.offset)) throw new ShareLinkError("truncated");
    return Number(n);
  }

  /** Unsigned LEB128 into a 64-bit value; more than 10 bytes is truncated. */
  varint() {
    let result = 0n;
    let shift = 0n;
    for (;;) {
      const b = this.byte();
      result = (result | (BigInt(b & 0x7f) << shift)) & MASK64;
      if ((b & 0x80) === 0) return result;
      shift += 7n;
      if (shift > 63n) throw new ShareLinkError("truncated");
    }
  }
}

/** Swift: Int(Int64(bitPattern: v >> 1) ^ -Int64(bitPattern: v & 1)) */
function unzigzag(v) {
  return BigInt.asIntN(64, (v >> 1n) ^ -(v & 1n));
}

/**
 * Decodes the part of a share link after the `#`.
 * @param {string} payload
 * @returns {{name: string, distance: number, coordinates: {lat: number, lon: number}[]}}
 * @throws {ShareLinkError}
 */
export function decodeShareLink(payload) {
  const bytes = fromBase64url(String(payload));
  if (!bytes) throw new ShareLinkError("invalidBase64");
  const reader = new ByteReader(bytes);
  const v = reader.byte();
  if (v !== VERSION) throw new ShareLinkError("unsupportedVersion", v);
  const nameLength = reader.length();
  // ignoreBOM keeps a leading U+FEFF, like Swift's String(decoding:as:).
  const name = new TextDecoder("utf-8", { ignoreBOM: true }).decode(reader.take(nameLength));
  const distance = Number(reader.varint());
  const count = reader.length();
  if (count < 2) throw new ShareLinkError("invalidRoute");
  const coordinates = [];
  let lat = 0n;
  let lon = 0n;
  for (let i = 0; i < count; i++) {
    // Wrapping adds, like Swift's &+=.
    lat = BigInt.asIntN(64, lat + unzigzag(reader.varint()));
    lon = BigInt.asIntN(64, lon + unzigzag(reader.varint()));
    if (lat < -MAX_LAT || lat > MAX_LAT || lon < -MAX_LON || lon > MAX_LON) {
      throw new ShareLinkError("invalidRoute");
    }
    coordinates.push({ lat: Number(lat) / SCALE, lon: Number(lon) / SCALE });
  }
  return { name, distance, coordinates };
}

// MARK: - Geometry (mirrors Geo.swift)

const rad = (d) => (d * Math.PI) / 180;

/** Great-circle distance in meters. */
export function distance(a, b) {
  const φ1 = rad(a.lat);
  const φ2 = rad(b.lat);
  const s1 = Math.sin((φ2 - φ1) / 2);
  const s2 = Math.sin(rad(b.lon - a.lon) / 2);
  const h = s1 * s1 + Math.cos(φ1) * Math.cos(φ2) * s2 * s2;
  return 2 * EARTH_RADIUS * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function pathLength(coords) {
  let total = 0;
  for (let i = 1; i < coords.length; i++) total += distance(coords[i - 1], coords[i]);
  return total;
}

/** The point `meters` along a polyline, or null if it's shorter than that. */
export function pointAlong(coords, meters) {
  if (!(meters >= 0) || coords.length === 0) return null;
  if (meters === 0) return coords[0];
  let walked = 0;
  for (let i = 1; i < coords.length; i++) {
    const a = coords[i - 1];
    const b = coords[i];
    const d = distance(a, b);
    if (walked + d >= meters && d > 0) {
      const t = (meters - walked) / d;
      return { lat: a.lat + (b.lat - a.lat) * t, lon: a.lon + (b.lon - a.lon) * t };
    }
    walked += d;
  }
  return null;
}

// MARK: - What kind of route (mirrors RunDistance and RouteGuide.outAndBackTurnaround)

const GOALS = [
  { meters: 5000, short: "5K", name: "5K" },
  { meters: 10000, short: "10K", name: "10K" },
  { meters: 21097.5, short: "Half", name: "half marathon" },
  { meters: 42195, short: "Marathon", name: "marathon" },
];

/** The longest standard distance a route covers ({meters, short, name}), or null under 5K. */
export function goalFor(meters) {
  let goal = null;
  // Share links round to the meter: a meter of slack.
  for (const g of GOALS) if (meters + 1 >= g.meters) goal = g;
  return goal;
}

/** True when the way back retraces the way out (an out-and-back), not a loop. */
export function isOutAndBack(coords) {
  if (coords.length < 3 || distance(coords[0], coords[coords.length - 1]) >= 60) return false;
  const total = pathLength(coords);
  if (total <= 300) return false;
  for (let k = 1; k < 20; k++) {
    const d = (total * k) / 40;
    const a = pointAlong(coords, d);
    const b = pointAlong(coords, total - d);
    if (!a || !b || distance(a, b) >= 30) return false;
  }
  return true;
}

// MARK: - GPX (byte-for-byte the same as GPX.swift)

function escapeXML(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** printf("%.6f"): keeps the sign of negative zero, which toFixed drops. */
function fixed6(x) {
  const s = x.toFixed(6);
  return Object.is(x, -0) || (x < 0 && !s.startsWith("-")) ? `-${s}` : s;
}

export function toGPX(name, coords) {
  const points = coords
    .map((c) => `      <trkpt lat="${fixed6(c.lat)}" lon="${fixed6(c.lon)}"/>`)
    .join("\n");
  const n = escapeXML(name);
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<gpx version="1.1" creator="Lacelap" xmlns="http://www.topografix.com/GPX/1/1">\n` +
    `  <metadata><name>${n}</name></metadata>\n` +
    `  <trk>\n` +
    `    <name>${n}</name>\n` +
    `    <type>running</type>\n` +
    `    <trkseg>\n` +
    `${points}\n` +
    `    </trkseg>\n` +
    `  </trk>\n` +
    `</gpx>\n`
  );
}

/** A safe download filename: "Lacelap 5K" → "Lacelap-5K.gpx" (same dash rule as the app). */
export function gpxFilename(name) {
  const base = String(name)
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 60);
  return `${base || "Lacelap-route"}.gpx`;
}
