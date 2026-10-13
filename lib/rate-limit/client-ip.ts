import { isIP } from "node:net";

/**
 * The client key from one header value, or null when it is missing or not an
 * IP address. Takes the first comma-separated entry. IPv4 is returned as
 * written; IPv6 is reduced to its /64 prefix, so one subscriber cannot dodge
 * the limit by rotating addresses inside its prefix.
 */
export function clientIpKey(headerValue: string | null | undefined): string | null {
  const first = headerValue?.split(",")[0]?.trim();
  if (!first) return null;
  const version = isIP(first);
  if (version === 4) return first;
  if (version !== 6 || first.includes("%")) return null;
  const groups = expandIpv6(first);
  return groups ? `${groups.slice(0, 4).join(":")}::/64` : null;
}

/** Eight lower-case hex groups without leading zeros, or null. */
function expandIpv6(address: string): string[] | null {
  let text = address.toLowerCase();
  const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(text)?.[1];
  if (tail) {
    const [a, b, c, d] = tail.split(".").map(Number);
    text = text.slice(0, -tail.length) + `${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const all = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill("0"), ...rest];
  return all.map((group) => group.replace(/^0+(?=.)/, ""));
}

/** Reads only the named header; any other header, such as x-forwarded-for, is ignored. */
export function requestClientKey(headers: { get(name: string): string | null }, headerName: string): string | null {
  return clientIpKey(headers.get(headerName));
}
