import { useEffect, useRef, useState } from "react";
import Avatar from "./Avatar";
import {
  MicIcon,
  MicOffIcon,
  PhoneIcon,
  VideoIcon,
  VideoOffIcon,
} from "./icons";

function formatDuration(totalSeconds) {
  const minutes = String(Math.floor(totalSeconds / 60)).padStart(2, "0");
  const seconds = String(totalSeconds % 60).padStart(2, "0");

  return `${minutes}:${seconds}`;
}

function useElapsedSeconds(startedAt) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!startedAt) return;

    const timer = setInterval(() => setNow(Date.now()), 1000);

    return () => clearInterval(timer);
  }, [startedAt]);

  return startedAt ? Math.max(0, Math.floor((now - startedAt) / 1000)) : 0;
}

// A simple repeating two-note ring while a call is coming in.
function useRingtone(active) {
  useEffect(() => {
    if (!active) return;

    let context;
    let timer;

    try {
      context = new (window.AudioContext || window.webkitAudioContext)();

      const ring = () => {
        const now = context.currentTime;

        [
          [0, 523],
          [0.25, 659],
        ].forEach(([offset, frequency]) => {
          const oscillator = context.createOscillator();
          const gain = context.createGain();

          oscillator.frequency.value = frequency;
          gain.gain.setValueAtTime(0.0001, now + offset);
          gain.gain.exponentialRampToValueAtTime(0.12, now + offset + 0.03);
          gain.gain.exponentialRampToValueAtTime(0.0001, now + offset + 0.22);

          oscillator.connect(gain).connect(context.destination);
          oscillator.start(now + offset);
          oscillator.stop(now + offset + 0.25);
        });
      };

      context.resume?.();
      ring();
      timer = setInterval(ring, 1800);
    } catch {
      // The ring is optional; the call screen still shows.
    }

    return () => {
      clearInterval(timer);
      context?.close?.().catch(() => {});
    };
  }, [active]);
}

function StreamPlayer({ stream, kind = "video", muted = false, className }) {
  const ref = useRef(null);

  useEffect(() => {
    if (ref.current) ref.current.srcObject = stream ?? null;
  }, [stream]);

  if (kind === "audio") {
    return <audio ref={ref} autoPlay />;
  }

  return (
    <video
      ref={ref}
      autoPlay
      playsInline
      muted={muted}
      className={className}
    />
  );
}

function RoundButton({ onClick, label, tone = "dark", active, children }) {
  const tones = {
    dark: active
      ? "bg-white text-slate-900"
      : "bg-white/15 text-white hover:bg-white/25",
    red: "bg-red-600 text-white hover:bg-red-500",
    green: "bg-emerald-500 text-white hover:bg-emerald-400",
  };

  return (
    <button
      onClick={onClick}
      aria-label={label}
      title={label}
      className={`flex h-14 w-14 items-center justify-center rounded-full transition ${tones[tone]}`}
    >
      {children}
    </button>
  );
}

export default function CallOverlay({
  call,
  localStream,
  remoteStream,
  notice,
  onAccept,
  onDecline,
  onHangUp,
  onToggleMute,
  onToggleCamera,
}) {
  const elapsed = useElapsedSeconds(call?.startedAt);

  useRingtone(call?.status === "incoming");

  if (!call) {
    return notice ? (
      <div
        role="status"
        className="fixed left-1/2 top-5 z-70 -translate-x-1/2 rounded-xl border border-slate-700 bg-slate-800 px-4 py-3 text-sm shadow-xl"
      >
        {notice}
      </div>
    ) : null;
  }

  const isVideo = call.type === "video";
  const isIncoming = call.status === "incoming";
  const isCalling = call.status === "calling";
  const isLive = call.status === "connecting" || call.status === "connected";
  const showRemoteVideo = isVideo && isLive && remoteStream;

  const statusText = isIncoming
    ? `Incoming ${isVideo ? "video" : "voice"} call`
    : isCalling
      ? "Calling..."
      : call.status === "connecting"
        ? "Connecting..."
        : formatDuration(elapsed);

  return (
    <div
      role="dialog"
      aria-label="Call"
      className="fixed inset-0 z-60 flex flex-col overflow-hidden bg-slate-950 text-white"
    >
      {/* Background video */}
      {showRemoteVideo && (
        <StreamPlayer
          stream={remoteStream}
          className="absolute inset-0 h-full w-full object-cover"
        />
      )}

      {isVideo && isCalling && localStream && (
        <StreamPlayer
          stream={localStream}
          muted
          className="absolute inset-0 h-full w-full -scale-x-100 object-cover opacity-40"
        />
      )}

      {/* Sound for voice calls */}
      {!isVideo && remoteStream && (
        <StreamPlayer stream={remoteStream} kind="audio" />
      )}

      {/* Name and status */}
      {showRemoteVideo ? (
        <div className="relative z-10 bg-linear-to-b from-black/60 to-transparent px-5 pb-8 pt-[max(1rem,env(safe-area-inset-top))]">
          <p className="font-semibold">{call.peer.username}</p>
          <p className="text-sm text-slate-200">{statusText}</p>
        </div>
      ) : (
        <div className="relative z-10 flex flex-1 flex-col items-center justify-center px-6 text-center">
          <div className={isIncoming || isCalling ? "animate-pulse" : ""}>
            <Avatar
              name={call.peer.username}
              size="h-28 w-28"
              text="text-5xl"
            />
          </div>

          <h2 className="mt-5 text-2xl font-bold">{call.peer.username}</h2>
          <p className="mt-1 text-slate-300">{statusText}</p>
        </div>
      )}

      {showRemoteVideo && <div className="flex-1" />}

      {/* Your own camera */}
      {isVideo && isLive && localStream && (
        <StreamPlayer
          stream={localStream}
          muted
          className="absolute bottom-32 right-4 z-10 h-40 w-28 -scale-x-100 rounded-2xl border border-white/30 bg-slate-800 object-cover shadow-xl"
        />
      )}

      {/* Buttons */}
      <div className="relative z-10 flex items-center justify-center gap-6 pb-[max(2rem,env(safe-area-inset-bottom))] pt-4">
        {isIncoming ? (
          <>
            <RoundButton onClick={onDecline} label="Decline" tone="red">
              <PhoneIcon className="h-6 w-6 rotate-135" />
            </RoundButton>

            <RoundButton onClick={onAccept} label="Accept" tone="green">
              {isVideo ? <VideoIcon /> : <PhoneIcon />}
            </RoundButton>
          </>
        ) : (
          <>
            <RoundButton
              onClick={onToggleMute}
              label={call.muted ? "Unmute" : "Mute"}
              active={call.muted}
            >
              {call.muted ? <MicOffIcon /> : <MicIcon />}
            </RoundButton>

            {isVideo && (
              <RoundButton
                onClick={onToggleCamera}
                label={call.cameraOff ? "Turn camera on" : "Turn camera off"}
                active={call.cameraOff}
              >
                {call.cameraOff ? <VideoOffIcon /> : <VideoIcon />}
              </RoundButton>
            )}

            <RoundButton onClick={onHangUp} label="End call" tone="red">
              <PhoneIcon className="h-6 w-6 rotate-135" />
            </RoundButton>
          </>
        )}
      </div>
    </div>
  );
}
