export type AuthMode = "password" | "google";

/** Production never accepts password sessions, including sessions issued before the cutover. */
export function authMode(env: Record<string, string | undefined> = process.env): AuthMode {
  return env.JG_ENV === "production" || env.JG_AUTH_MODE === "google" ? "google" : "password";
}

export interface GoogleSettings { origin: string; clientId: string; clientSecret: string }
export function googleSettings(env: Record<string, string | undefined> = process.env): GoogleSettings | null {
  try {
    const url = new URL(env.JG_APP_URL ?? "");
    const local = env.JG_ENV === "local" && ["localhost", "127.0.0.1"].includes(url.hostname);
    if ((url.protocol !== "https:" && !local) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) return null;
    const clientId = env.GOOGLE_CLIENT_ID?.trim(), clientSecret = env.GOOGLE_CLIENT_SECRET?.trim();
    if (!clientId?.endsWith(".apps.googleusercontent.com") || !clientSecret) return null;
    return { origin: url.origin, clientId, clientSecret };
  } catch { return null; }
}
export function publicAuthSettings() {
  const mode = authMode();
  return { mode, configured: mode === "password" || googleSettings() !== null };
}
