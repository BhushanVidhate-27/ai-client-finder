async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function isValidAdmin(
  username: string,
  password: string,
): Promise<boolean> {
  const configuredUsername = process.env.ADMIN_USERNAME;
  const configuredPassword = process.env.ADMIN_PASSWORD;

  if (!configuredUsername || !configuredPassword) return false;

  const userDigest = await sha256Hex(username);
  const expectedUserDigest = await sha256Hex(configuredUsername);
  const passwordDigest = await sha256Hex(password);
  const expectedPasswordDigest = await sha256Hex(configuredPassword);

  return (
    safeEqual(userDigest, expectedUserDigest) &&
    safeEqual(passwordDigest, expectedPasswordDigest)
  );
}

export function isAdminCredentialsConfigured(): boolean {
  return Boolean(process.env.ADMIN_USERNAME && process.env.ADMIN_PASSWORD);
}