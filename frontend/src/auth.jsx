import { useEffect, useState } from "react";
import { API_URL } from "./config";


export function clearSession() {
  sessionStorage.removeItem("token");
  sessionStorage.removeItem("user");
}

/**
 * Checks the saved login token with the server.
 * Returns "checking" | "valid" | "invalid".
 *
 * Only an explicit 401/403 from the server logs the user out. If the server
 * can't be reached, the saved login is kept so a refresh never logs you out.
 */
export function useSession() {
  const [status, setStatus] = useState(() =>
    sessionStorage.getItem("token") ? "checking" : "invalid",
  );

  useEffect(() => {
    const token = sessionStorage.getItem("token");
    if (!token) return;

    let cancelled = false;

    fetch(`${API_URL}/me`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(async (response) => {
        if (cancelled) return;

        if (response.ok) {
          const data = await response.json();
          sessionStorage.setItem("user", JSON.stringify(data.user));
          setStatus("valid");
        } else if (response.status === 401 || response.status === 403) {
          clearSession();
          setStatus("invalid");
        } else {
          setStatus("valid");
        }
      })
      .catch(() => {
        if (!cancelled) setStatus("valid");
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return status;
}