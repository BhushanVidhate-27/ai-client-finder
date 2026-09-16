export const SESSION_COOKIE_NAME = "aicf_session";
export const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 7;

interface SessionPayload {
  sub: string;
  exp: number;
}

function getSecret(): string {
  return process.env.SESSION_SECRET ?? "";
}

function b64urlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(input: string): Uint8Array {
  const padded = input.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function hmacHex(message: string, key: string): Promise<string> {
  const secretKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    secretKey,
    new TextEncoder().encode(message),
  );
  return Array.from(new Uint8Array(signature))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function createSessionToken(
  sub: string,
  maxAgeSeconds = SESSION_MAX_AGE_SECONDS,
): Promise<string> {
  const payload: SessionPayload = {
    sub,
    exp: Math.floor(Date.now() / 1000) + maxAgeSeconds,
  };
  const payloadEncoded = b64urlEncode(
    new TextEncoder().encode(JSON.stringify(payload)),
  );
  const signature = await hmacHex(payloadEncoded, getSecret());
  return `${payloadEncoded}.${signature}`;
}

export async function verifySessionToken(
  token: string,
): Promise<string | null> {
  const secret = getSecret();
  if (!secret) return null;

  const dotIndex = token.indexOf(".");
  if (dotIndex <= 0) return null;
  const payloadEncoded = token.slice(0, dotIndex);
  const signature = token.slice(dotIndex + 1);

  const expected = await hmacHex(payloadEncoded, secret);
  if (!safeEqual(signature, expected)) return null;

  let payload: SessionPayload;
  try {
    payload = JSON.parse(
      new TextDecoder().decode(b64urlDecode(payloadEncoded)),
    ) as SessionPayload;
  } catch {
    return null;
  }

  if (typeof payload.sub !== "string" || typeof payload.exp !== "number") {
    return null;
  }
  if (payload.exp < Math.floor(Date.now() / 1000)) return null;

  return payload.sub;
}