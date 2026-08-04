// Lightweight HMAC-signed tokens for admin session cookies and emailed magic links.
// Not a full auth system — appropriate for a small internal tool where the emailed
// links are already gated by knowing the recipient's own email address.

async function hmac(secret, message) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function signPayload(secret, payload) {
  const body = JSON.stringify(payload);
  const encoded = btoa(body);
  const sig = await hmac(secret, encoded);
  return `${encoded}.${sig}`;
}

export async function verifyPayload(secret, token) {
  if (!token || !token.includes('.')) return null;
  const [encoded, sig] = token.split('.');
  const expected = await hmac(secret, encoded);
  if (expected !== sig) return null;
  try {
    return JSON.parse(atob(encoded));
  } catch {
    return null;
  }
}

export async function createAdminSessionCookie(env) {
  const token = await signPayload(env.ADMIN_PASSWORD, { exp: Date.now() + 1000 * 60 * 60 * 12 });
  return `admin_session=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=43200`;
}

export async function isAdminRequest(request, env) {
  const cookie = request.headers.get('Cookie') || '';
  const match = cookie.match(/admin_session=([^;]+)/);
  if (!match) return false;
  const payload = await verifyPayload(env.ADMIN_PASSWORD, decodeURIComponent(match[1]));
  return !!payload && payload.exp > Date.now();
}

export async function createMagicToken(env, payload) {
  return signPayload(env.ADMIN_PASSWORD, payload);
}

export async function verifyMagicToken(env, token) {
  return verifyPayload(env.ADMIN_PASSWORD, token);
}
