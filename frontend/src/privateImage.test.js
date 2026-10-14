import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const PATH = `/conversations/12/images/${"a".repeat(32)}.jpg`;
const BLOB_URL = "blob:http://localhost/photo-1";

let fetchMock;
let loadPrivateImage;
let clearPrivateImages;

beforeEach(async () => {
  vi.resetModules();
  sessionStorage.setItem("token", "TOKEN-123");

  fetchMock = vi.fn(async () => ({ ok: true, status: 200, blob: async () => new Blob(["x"]) }));
  vi.stubGlobal("fetch", fetchMock);
  URL.createObjectURL = vi.fn(() => BLOB_URL);
  URL.revokeObjectURL = vi.fn();

  ({ loadPrivateImage, clearPrivateImages } = await import("./privateImage"));
});

afterEach(() => {
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

describe("loadPrivateImage", () => {
  it("downloads the photo with the login token and returns a local address", async () => {
    const url = await loadPrivateImage(PATH);

    expect(url).toBe(BLOB_URL);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [requested, options] = fetchMock.mock.calls[0];
    expect(requested).toBe(`http://localhost:3000${PATH}`);
    expect(options.headers.Authorization).toBe("Bearer TOKEN-123");
  });

  it("downloads each photo once, even when asked many times at the same moment", async () => {
    await Promise.all([loadPrivateImage(PATH), loadPrivateImage(PATH), loadPrivateImage(PATH)]);
    await loadPrivateImage(PATH);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("never sends the token anywhere except the server's own photo addresses", async () => {
    const bad = [
      "http://evil.example/photo.jpg",
      "//evil.example/photo.jpg",
      "@evil.example/photo.jpg",
      `/uploads/${"a".repeat(32)}.jpg`,
      `/conversations/12/images/../../secret`,
      `/conversations/12/images/${"a".repeat(32)}.jpg?x=1`,
      `/conversations/12/images/${"a".repeat(32)}.exe`,
      `/conversations/0/images/${"a".repeat(32)}.jpg`,
      "",
      null,
      undefined,
      42,
      {},
    ];

    for (const path of bad) {
      await expect(loadPrivateImage(path)).rejects.toThrow("Not a photo address");
    }

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([401, 403, 404, 500])("fails on a %i answer and tries again next time", async (status) => {
    fetchMock.mockResolvedValueOnce({ ok: false, status, blob: async () => new Blob() });

    await expect(loadPrivateImage(PATH)).rejects.toThrow();
    expect(await loadPrivateImage(PATH)).toBe(BLOB_URL);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("fails when the network is down, without remembering the failure", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));

    await expect(loadPrivateImage(PATH)).rejects.toThrow("fetch failed");
    expect(await loadPrivateImage(PATH)).toBe(BLOB_URL);
  });
});

describe("clearPrivateImages", () => {
  it("frees the downloaded photos and forgets them", async () => {
    await loadPrivateImage(PATH);
    clearPrivateImages();
    await Promise.resolve();

    expect(URL.revokeObjectURL).toHaveBeenCalledWith(BLOB_URL);

    await loadPrivateImage(PATH);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("is safe to call when nothing was loaded", () => {
    expect(() => clearPrivateImages()).not.toThrow();
  });
});
