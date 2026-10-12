const MAX_SIDE = 1280;

/**
 * Shrinks a photo before it is sent: at most 1280px on the longest side,
 * saved as a JPEG. This keeps uploads small and removes hidden camera
 * details such as GPS location.
 */
export async function prepareImage(file) {
  let bitmap;

  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    bitmap = await createImageBitmap(file);
  }

  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");

  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));

  const context = canvas.getContext("2d");

  // JPEG has no transparency, so paint white behind transparent PNGs.
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();

  const blob = await new Promise((resolve) =>
    canvas.toBlob(resolve, "image/jpeg", 0.82),
  );

  if (!blob) throw new Error("Could not process the image");

  return blob;
}
