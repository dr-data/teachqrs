function bytesToB64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function b64ToBytes(value: string): Uint8Array {
  const bin = atob(value);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function pbkdf2(password: string, salt: Uint8Array): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations: 100_000 },
    key,
    256,
  );
  return new Uint8Array(bits);
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const derived = await pbkdf2(password, salt);
  return `${bytesToB64(salt)}$${bytesToB64(derived)}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [saltB64, hashB64] = stored.split("$");
  if (!saltB64 || !hashB64) return false;
  const derived = await pbkdf2(password, b64ToBytes(saltB64));
  const expected = b64ToBytes(hashB64);
  if (derived.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < derived.length; i++) diff |= derived[i] ^ expected[i];
  return diff === 0;
}

async function hmac(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return bytesToB64(new Uint8Array(sig));
}

export async function signPayload(secret: string, payload: Record<string, unknown>): Promise<string> {
  const data = bytesToB64(new TextEncoder().encode(JSON.stringify(payload)));
  const sig = await hmac(secret, data);
  return `${data}.${sig}`;
}

export async function readPayload(secret: string, token: string | undefined): Promise<Record<string, unknown> | null> {
  if (!token) return null;
  const [data, sig] = token.split(".");
  if (!data || !sig) return null;
  const expected = await hmac(secret, data);
  if (expected.length !== sig.length) return null;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
  if (diff !== 0) return null;
  try {
    return JSON.parse(new TextDecoder().decode(b64ToBytes(data))) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export const COOKIE_TEACHER = "teachqrs_teacher";
export const COOKIE_STUDENT = "teachqrs_student";
export const COOKIE_FLASH = "teachqrs_flash";
