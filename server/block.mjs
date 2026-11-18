  import { readFileSync, statSync } from "node:fs";
  
  const OCTET = /^\d{1,3}$/;
  const LOOPBACK_START = 127 * 16777216;
  
  function octet(value) {
    if (!OCTET.test(value)) return -1;
    const parsed = Number(value);
    return parsed <= 255 ? parsed : -1;
  }
  
  function addressNumber(value) {
    if (typeof value !== "string") return null;
    let text = value.trim().toLowerCase();
    if (text.startsWith("::ffff:")) text = text.slice(7);
    const parts = text.split(".");
    if (parts.length !== 4) return null;
    const octets = parts.map(octet);
    if (octets.some((part) => part < 0)) return null;
    return (octets[0] * 16777216 + octets[1] * 65536 + octets[2] * 256 + octets[3]) >>> 0;
  }
  
  function addressFromNumber(value) {
    return [
      Math.floor(value / 16777216) & 255,
      Math.floor(value / 65536) & 255,
      Math.floor(value / 256) & 255,
      value & 255,
    ].join(".");
  }
  
  function networkNumber(value, prefix) {
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
    return (value & mask) >>> 0;
  }
  
  function rangeOverlap(start, prefix, otherStart, otherPrefix) {
    const end = start + 2 ** (32 - prefix) - 1;
    const otherEnd = otherStart + 2 ** (32 - otherPrefix) - 1;
    return start <= otherEnd && otherStart <= end;
  }
  
  export function normalizeBlock(input) {
    if (typeof input !== "string") return null;
    const text = input.trim();
    if (!text || /[,\s]/.test(text)) return null;
    const slash = text.indexOf("/");
    const address = slash === -1 ? text : text.slice(0, slash);
    const prefixText = slash === -1 ? "" : text.slice(slash + 1);
    if (slash !== -1 && (text.indexOf("/", slash + 1) !== -1 || !/^\d{1,2}$/.test(prefixText))) return null;
  
    const parts = address.split(".");
    if (parts.length !== 4) return null;
    const octets = [];
    let wildcard = -1;
    for (let index = 0; index < 4; index++) {
      const part = parts[index];
      if (part === "*") {
        if (wildcard === -1) wildcard = index;
        octets.push(0);
        continue;
      }
      if (wildcard !== -1) return null;
      const parsed = octet(part);
      if (parsed < 0) return null;
      octets.push(parsed);
    }
    let prefix = wildcard === -1 ? 32 : wildcard * 8;
    if (prefixText) {
      if (wildcard !== -1) return null;
      prefix = Number(prefixText);
    }
    if (prefix < 1 || prefix > 32) return null;
  
    const value = (octets[0] * 16777216 + octets[1] * 65536 + octets[2] * 256 + octets[3]) >>> 0;
    const network = networkNumber(value, prefix);
    if (rangeOverlap(network, prefix, LOOPBACK_START, 8)) return null;
    return `${addressFromNumber(network)}/${prefix}`;
  }
  
  export function normalizeBlockList(text) {
    const rules = [];
    const invalid = [];
    for (const raw of String(text ?? "").split(/[\s,]+/)) {
      if (!raw || raw.startsWith("#")) continue;
      const rule = normalizeBlock(raw);
      if (!rule) {
        invalid.push(raw);
        continue;
      }
      if (!rules.includes(rule)) rules.push(rule);
    }
    return { rules, invalid };
  }
  
  export function parseBlock(text) {
    return normalizeBlockList(String(text ?? "").replace(/#.*$/gm, "")).rules;
  }
  
  export function matchesBlock(ip, rules) {
    const value = addressNumber(ip);
    if (value === null || !Array.isArray(rules)) return false;
    for (const rule of rules) {
      const [base, prefixText] = String(rule).split("/");
      const prefix = Number(prefixText);
      const network = addressNumber(base);
      if (network === null || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) continue;
      if (networkNumber(value, prefix) === networkNumber(network, prefix)) return true;
    }
    return false;
  }
  
  export function createBlock({
    file = process.env.LYRA_BLOCK || "/etc/lyra/block",
    refreshMs = 2_000,
    now = Date.now,
    read = readFileSync,
    stat = statSync,
  } = {}) {
    let rules = [];
    let signature = null;
    let checkedAt = -Infinity;
  
    const refresh = () => {
      checkedAt = now();
      try {
        const info = stat(file);
        const next = `${info.mtimeMs}:${info.size}`;
        if (next === signature) return;
        signature = next;
        rules = parseBlock(read(file, "utf8"));
      } catch {
        signature = null;
        rules = [];
      }
    };
  
    refresh();
  
    return {
      matches(ip) {
        if (now() - checkedAt >= refreshMs) refresh();
        return matchesBlock(ip, rules);
      },
      rules() {
        return [...rules];
      },
    };
  }
