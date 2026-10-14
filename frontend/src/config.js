// Where the backend lives. Set VITE_API_URL in frontend/.env when the site is
// hosted online, for example VITE_API_URL=https://api.example.com
export const API_URL = (
  import.meta.env.VITE_API_URL || "https://pyeonghwa.onrender.com"
).replace(/\/+$/, "");

// Debug switch: VITE_FORCE_RELAY=true makes every call go through the TURN
// server. If calls still work, the relay is set up correctly.
export const FORCE_RELAY = import.meta.env.VITE_FORCE_RELAY === "true";
