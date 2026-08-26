import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";

type LookupAddress = { address: string; family: number };
type LookupFunction = (hostname: string) => Promise<LookupAddress[]>;

const INTERNAL_HOST_SUFFIXES = [".localhost", ".local", ".internal", ".lan", ".home", ".corp"];
const NETWORK_PROTOCOLS = new Set(["http:", "https:"]);
const SAFE_INTERNAL_RESOURCE_PROTOCOLS = new Set(["about:", "blob:", "data:"]);

export function routedRequestProtocolPolicy(value: string, topLevelNavigation: boolean) {
  let protocol: string;
  try {
    protocol = new URL(value).protocol;
  } catch {
    return { allowed: false as const, message: "The request URL is invalid." };
  }
  if (NETWORK_PROTOCOLS.has(protocol)) return { allowed: true as const, validateNetworkTarget: true as const };
  if (!topLevelNavigation && SAFE_INTERNAL_RESOURCE_PROTOCOLS.has(protocol)) {
    return { allowed: true as const, validateNetworkTarget: false as const };
  }
  return { allowed: false as const, message: "Only top-level HTTP(S) navigation is allowed." };
}

function ipv4Number(address: string) {
  return address.split(".").reduce((value, part) => (value << 8) + Number(part), 0) >>> 0;
}

function inIpv4Range(address: string, network: string, bits: number) {
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (ipv4Number(address) & mask) === (ipv4Number(network) & mask);
}

export function isPrivateAddress(address: string) {
  const normalized = address.toLowerCase().split("%")[0];
  if (normalized.startsWith("::ffff:")) return isPrivateAddress(normalized.slice(7));
  if (isIP(normalized) === 4) {
    return [
      ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10],
      ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
      ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.168.0.0", 16],
      ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24],
      ["224.0.0.0", 4], ["240.0.0.0", 4],
    ].some(([network, bits]) => inIpv4Range(normalized, String(network), Number(bits)));
  }
  if (isIP(normalized) === 6) {
    return (
      normalized === "::" || normalized === "::1" ||
      normalized.startsWith("fc") || normalized.startsWith("fd") ||
      /^fe[89ab]/.test(normalized) || normalized.startsWith("2001:db8:")
    );
  }
  return true;
}

const defaultLookup: LookupFunction = async (hostname) => {
  const addresses = await dnsLookup(hostname, { all: true, verbatim: true });
  return addresses.map(({ address, family }) => ({ address, family }));
};

export async function validatePublicUrl(
  value: string,
  options: { lookup?: LookupFunction; allowPrivate?: boolean } = {},
) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { allowed: false as const, status: "URL_BLOCKED" as const, message: "The URL is invalid." };
  }
  if (!NETWORK_PROTOCOLS.has(url.protocol) || url.username || url.password) {
    return { allowed: false as const, status: "URL_BLOCKED" as const, message: "Only normal HTTP(S) URLs without embedded credentials are allowed." };
  }
  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  if (
    !hostname || hostname === "localhost" || hostname === "metadata.google.internal" ||
    INTERNAL_HOST_SUFFIXES.some((suffix) => hostname.endsWith(suffix)) ||
    (!hostname.includes(".") && isIP(hostname) === 0)
  ) {
    if (options.allowPrivate !== true) {
      return { allowed: false as const, status: "URL_BLOCKED" as const, message: "Private or internal hostnames are blocked." };
    }
  }
  const allowPrivate = options.allowPrivate === true;
  try {
    const addresses = isIP(hostname)
      ? [{ address: hostname, family: isIP(hostname) }]
      : await (options.lookup ?? defaultLookup)(hostname);
    if (!addresses.length || (!allowPrivate && addresses.some(({ address }) => isPrivateAddress(address)))) {
      return { allowed: false as const, status: "URL_BLOCKED" as const, message: "The URL resolves to a private or reserved network." };
    }
  } catch {
    return { allowed: false as const, status: "URL_BLOCKED" as const, message: "The URL hostname could not be safely resolved." };
  }
  url.username = "";
  url.password = "";
  return { allowed: true as const, url };
}

export function developmentPrivateNetworkEscapeEnabled() {
  return process.env.NODE_ENV !== "production" && process.env.KINO_BROWSER_ALLOW_PRIVATE_NETWORKS === "true";
}
