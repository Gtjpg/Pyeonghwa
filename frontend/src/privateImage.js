import { API_URL } from "./config";

// Photos are private, so the browser can't load them with a plain <img src>
// (that can't send the login token). They are downloaded with the token and
// shown from a temporary local address instead.
const cache = new Map(); // photo path -> Promise<local address>

// Only the server's own photo addresses are ever requested. This keeps the
// login token from being sent anywhere else, whatever a message contains.
const PHOTO_PATH = /^\/conversations\/[1-9]\d{0,9}\/images\/[a-f0-9]{32}\.(jpg|png|webp)$/;

export function loadPrivateImage(path) {
  if (typeof path !== "string" || !PHOTO_PATH.test(path)) {
    return Promise.reject(new Error("Not a photo address"));
  }

  if (!cache.has(path)) {
    const request = fetch(`${API_URL}${path}`, {
      headers: { Authorization: `Bearer ${sessionStorage.getItem("token")}` },
    })
      .then(async (response) => {
        if (!response.ok) throw new Error(`Photo answered ${response.status}`);

        return URL.createObjectURL(await response.blob());
      })
      .catch((error) => {
        // Don't remember failures; the next try should ask again.
        cache.delete(path);
        throw error;
      });

    cache.set(path, request);
  }

  return cache.get(path);
}

// Frees the downloaded photos (on log out or when history is deleted).
export function clearPrivateImages() {
  for (const request of cache.values()) {
    request.then((url) => URL.revokeObjectURL(url)).catch(() => {});
  }

  cache.clear();
}
