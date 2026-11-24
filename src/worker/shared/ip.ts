export function parseIpv4Octets(value: string): [number, number, number, number] | null {
  const octets = value.split('.');
  if (octets.length !== 4) return null;
  const parsed: number[] = [];
  for (const part of octets) {
    if (!/^(?:0|[1-9]\d{0,2})$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    parsed.push(n);
  }
  return [parsed[0]!, parsed[1]!, parsed[2]!, parsed[3]!];
}

export function parseIpv6Hextets(raw: string): number[] | null {
  const unwrapped = raw.startsWith('[') && raw.endsWith(']') ? raw.slice(1, -1) : raw;
  const withoutZone = unwrapped.split('%', 1)[0] ?? unwrapped;
  const halves = withoutZone.split('::');
  if (halves.length > 2) return null;

  const parseSide = (side: string): number[] | null => {
    if (!side) return [];
    const parts = side.split(':');
    const result: number[] = [];
    for (let index = 0; index < parts.length; index += 1) {
      const token = parts[index]!;
      if (index === parts.length - 1 && token.includes('.')) {
        const octets = parseIpv4Octets(token);
        if (!octets) return null;
        result.push((octets[0] << 8) | octets[1], (octets[2] << 8) | octets[3]);
      } else {
        if (!/^[0-9a-f]{1,4}$/i.test(token)) return null;
        result.push(Number.parseInt(token, 16));
      }
    }
    return result;
  };

  const left = parseSide(halves[0]!);
  if (!left) return null;
  if (halves.length === 1) return left.length === 8 ? left : null;

  const right = parseSide(halves[1]!);
  if (!right) return null;
  const missing = 8 - (left.length + right.length);
  if (missing < 1) return null;
  return [...left, ...Array<number>(missing).fill(0), ...right];
}

export function normalizeClientIp(raw: string): string {
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed.includes(':')) return trimmed;

  const hextets = parseIpv6Hextets(trimmed);
  if (!hextets) return trimmed;

  // Preserve individual identity for IPv4-mapped IPv6 addresses (::ffff:a.b.c.d).
  if (
    hextets[0] === 0 && hextets[1] === 0 && hextets[2] === 0
    && hextets[3] === 0 && hextets[4] === 0 && hextets[5] === 0xffff
  ) {
    const hi = hextets[6]!;
    const lo = hextets[7]!;
    return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
  }

  return `${hextets.slice(0, 4).map((group) => group.toString(16).padStart(4, '0')).join(':')}::/64`;
}

export function isPrivateOrReservedIpv4(octets: readonly [number, number, number, number]): boolean {
  const [a, b] = octets;
  return (
    a === 0
    || a === 10
    || a === 127
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 100 && b >= 64 && b <= 127)
  );
}

export function isPrivateOrReservedHost(hostname: string): boolean {
  const lower = hostname.trim().toLowerCase().replace(/\.+$/, '');
  if (lower === 'localhost' || lower.endsWith('.localhost')) return true;

  const ipv4 = parseIpv4Octets(lower);
  if (ipv4) return isPrivateOrReservedIpv4(ipv4);

  if (!lower.includes(':')) return false;
  const hextets = parseIpv6Hextets(lower);
  if (!hextets) return true;

  const allZero = hextets.every((group) => group === 0);
  const loopback = hextets.slice(0, 7).every((group) => group === 0) && hextets[7] === 1;
  const uniqueLocal = (hextets[0]! & 0xfe00) === 0xfc00;
  const linkLocal = (hextets[0]! & 0xffc0) === 0xfe80;
  const ipv4Mapped =
    hextets[0] === 0 && hextets[1] === 0 && hextets[2] === 0
    && hextets[3] === 0 && hextets[4] === 0 && hextets[5] === 0xffff;

  if (allZero || loopback || uniqueLocal || linkLocal || ipv4Mapped) return true;
  return false;
}
