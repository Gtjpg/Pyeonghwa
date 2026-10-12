import { API_URL } from "./config";

// Used when the server can't be reached. Works on the same network and for
// most home connections, but not through strict firewalls.
const FALLBACK_SERVERS = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
];

let cached = null;

/**
 * Asks the server which STUN/TURN servers to use. The server hands out
 * temporary TURN passwords, so nothing secret is stored in the website.
 */
export async function loadIceServers() {
  if (cached && cached.until > Date.now()) return cached.servers;

  try {
    const response = await fetch(`${API_URL}/ice-servers`, {
      headers: { Authorization: `Bearer ${sessionStorage.getItem("token")}` },
      signal: AbortSignal.timeout(4000),
    });

    if (!response.ok) throw new Error(`Server answered ${response.status}`);

    const data = await response.json();

    // Reuse for a while, but well before the temporary password expires.
    const keepMs = Math.min((data.ttl || 600) * 500, 60 * 60 * 1000);

    cached = { servers: data.iceServers, until: Date.now() + keepMs };

    return cached.servers;
  } catch (error) {
    console.warn("Could not load call servers, using the default:", error);

    return FALLBACK_SERVERS;
  }
}
