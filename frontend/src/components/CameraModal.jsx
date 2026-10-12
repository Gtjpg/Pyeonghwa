import { useEffect, useRef, useState } from "react";
import { CloseIcon, FlipIcon } from "./icons";

/** Full-screen camera. Take a photo, then it goes to the send preview. */
export default function CameraModal({ onCapture, onClose }) {
  const videoRef = useRef(null);
  const [facing, setFacing] = useState("user");
  const [error, setError] = useState("");
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let stream = null;

    navigator.mediaDevices
      .getUserMedia({
        video: {
          facingMode: facing,
          width: { ideal: 1280 },
          height: { ideal: 960 },
        },
        audio: false,
      })
      .then((result) => {
        if (cancelled) {
          result.getTracks().forEach((track) => track.stop());
          return;
        }

        stream = result;

        if (videoRef.current) videoRef.current.srcObject = result;
      })
      .catch((cameraError) => {
        console.error("Camera error:", cameraError);

        if (!cancelled) {
          setError(
            "Couldn't open the camera. Check that this site is allowed to use it.",
          );
        }
      });

    return () => {
      cancelled = true;
      stream?.getTracks().forEach((track) => track.stop());
    };
  }, [facing]);

  function capture() {
    const video = videoRef.current;

    if (!video || !video.videoWidth) return;

    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext("2d").drawImage(video, 0, 0);

    canvas.toBlob((blob) => blob && onCapture(blob), "image/jpeg", 0.9);
  }

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-black">
      <div className="flex items-center justify-between px-4 pb-2 pt-[max(1rem,env(safe-area-inset-top))]">
        <button
          onClick={onClose}
          className="rounded-full bg-white/10 p-2 text-white hover:bg-white/20"
          aria-label="Close camera"
        >
          <CloseIcon />
        </button>
      </div>

      <div className="relative flex min-h-0 flex-1 items-center justify-center">
        {error ? (
          <p className="max-w-xs px-6 text-center text-sm text-slate-300">
            {error}
          </p>
        ) : (
          <video
            ref={videoRef}
            autoPlay
            playsInline
            muted
            onLoadedData={() => setReady(true)}
            className={`max-h-full max-w-full object-contain ${
              facing === "user" ? "-scale-x-100" : ""
            }`}
          />
        )}
      </div>

      <div className="flex items-center justify-center gap-10 pb-[max(1.5rem,env(safe-area-inset-bottom))] pt-4">
        <span className="w-12" />

        <button
          onClick={capture}
          disabled={!ready || !!error}
          className="h-18 w-18 rounded-full border-4 border-white bg-white/20 transition hover:bg-white/40 disabled:opacity-40"
          aria-label="Take photo"
        />

        <button
          onClick={() => {
            setReady(false);
            setFacing((current) => (current === "user" ? "environment" : "user"));
          }}
          className="rounded-full bg-white/10 p-3 text-white hover:bg-white/20"
          aria-label="Switch camera"
        >
          <FlipIcon />
        </button>
      </div>
    </div>
  );
}
