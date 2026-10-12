import { useCallback, useEffect, useRef, useState } from "react";
import { FORCE_RELAY } from "./config";
import { loadIceServers } from "./ice";

const RING_TIMEOUT_MS = 45000;
const NOTICE_MS = 4000;

const END_NOTICES = {
  hangup: "Call ended",
  declined: "Call declined",
  busy: "They're on another call",
  offline: "They're offline right now",
  no_answer: "No answer",
  disconnected: "The call was disconnected",
  failed: "The call couldn't connect",
  unavailable: "This call isn't available",
};

function newCallId() {
  return (
    crypto.randomUUID?.() ??
    `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
  );
}

function getMedia(type) {
  return navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true },
    video: type === "video" ? { facingMode: "user" } : false,
  });
}

function mediaErrorMessage(error, type) {
  if (error?.name === "NotAllowedError") {
    return type === "video"
      ? "Allow camera and microphone access to make video calls."
      : "Allow microphone access to make calls.";
  }

  if (error?.name === "NotFoundError") {
    return type === "video"
      ? "No camera or microphone was found."
      : "No microphone was found.";
  }

  return "Couldn't start the call. Check your camera and microphone.";
}

/**
 * One-to-one audio and video calls.
 * The server only passes setup messages (offer, answer, ICE candidates).
 * Audio and video travel directly between the two browsers.
 *
 * call.status: "calling" | "incoming" | "connecting" | "connected"
 */
export function useCall(socket) {
  const [call, setCall] = useState(null);
  const [localStream, setLocalStream] = useState(null);
  const [remoteStream, setRemoteStream] = useState(null);
  const [notice, setNotice] = useState("");

  const callRef = useRef(null);
  const pcRef = useRef(null);
  const localStreamRef = useRef(null);
  const pendingIceRef = useRef([]);
  const offerRef = useRef(null);
  const iceReadyRef = useRef(false);
  const outgoingIceRef = useRef([]);
  const ringTimerRef = useRef(null);
  const noticeTimerRef = useRef(null);

  const showNotice = useCallback((text) => {
    clearTimeout(noticeTimerRef.current);
    setNotice(text);

    if (text) {
      noticeTimerRef.current = setTimeout(() => setNotice(""), NOTICE_MS);
    }
  }, []);

  // Keeps a copy in a ref so socket handlers always see the latest call.
  const updateCall = useCallback((next) => {
    const value = typeof next === "function" ? next(callRef.current) : next;

    callRef.current = value;
    setCall(value);
  }, []);

  const cleanup = useCallback(() => {
    clearTimeout(ringTimerRef.current);

    const pc = pcRef.current;

    if (pc) {
      pc.onicecandidate = null;
      pc.ontrack = null;
      pc.onconnectionstatechange = null;
      pc.close();
    }

    pcRef.current = null;

    localStreamRef.current?.getTracks().forEach((track) => track.stop());
    localStreamRef.current = null;

    pendingIceRef.current = [];
    offerRef.current = null;
    iceReadyRef.current = false;
    outgoingIceRef.current = [];

    setLocalStream(null);
    setRemoteStream(null);
  }, []);

  const finish = useCallback(
    (text) => {
      cleanup();
      updateCall(null);

      if (text) showNotice(text);
    },
    [cleanup, updateCall, showNotice],
  );

  // This side ends the call and tells the other person.
  const endCall = useCallback(
    (reason, text = "") => {
      const current = callRef.current;

      if (!current) return;

      socket?.emit("call:end", { callId: current.id, reason });
      finish(text);
    },
    [socket, finish],
  );

  // The server drops candidates for a call it doesn't know yet, so our own
  // candidates wait here until it confirms the call (see markIceReady).
  const sendIce = useCallback(
    (callId, candidate) => {
      if (iceReadyRef.current) {
        socket.emit("call:ice", { callId, candidate });
      } else {
        outgoingIceRef.current.push(candidate);
      }
    },
    [socket],
  );

  const markIceReady = useCallback(
    (callId) => {
      iceReadyRef.current = true;

      const waiting = outgoingIceRef.current;
      outgoingIceRef.current = [];

      waiting.forEach((candidate) =>
        socket.emit("call:ice", { callId, candidate }),
      );
    },
    [socket],
  );

  const createPeer = useCallback(
    (callId, iceServers) => {
      const pc = new RTCPeerConnection({
        iceServers,
        // Debug option: only use the TURN relay (see VITE_FORCE_RELAY).
        iceTransportPolicy: FORCE_RELAY ? "relay" : "all",
      });

      pc.onicecandidate = (event) => {
        if (event.candidate) sendIce(callId, event.candidate.toJSON());
      };

      pc.ontrack = (event) => {
        if (event.streams[0]) setRemoteStream(event.streams[0]);
      };

      pc.onconnectionstatechange = () => {
        if (callRef.current?.id !== callId) return;

        if (pc.connectionState === "connected") {
          updateCall(
            (previous) =>
              previous && {
                ...previous,
                status: "connected",
                startedAt: previous.startedAt ?? Date.now(),
              },
          );
        } else if (pc.connectionState === "failed") {
          endCall("failed", END_NOTICES.failed);
        }
      };

      return pc;
    },
    [sendIce, updateCall, endCall],
  );

  // Candidates can arrive before the remote description is set. They wait here.
  const flushIce = useCallback(async () => {
    const pc = pcRef.current;

    if (!pc?.remoteDescription) return;

    const pending = pendingIceRef.current;
    pendingIceRef.current = [];

    for (const candidate of pending) {
      try {
        await pc.addIceCandidate(candidate);
      } catch (error) {
        console.warn("ICE candidate error:", error);
      }
    }
  }, []);

  const startCall = useCallback(
    async ({ conversationId, username, type }) => {
      if (!socket || callRef.current) return;

      if (
        !navigator.mediaDevices?.getUserMedia ||
        typeof RTCPeerConnection === "undefined"
      ) {
        showNotice("Calls need a modern browser on https or localhost.");
        return;
      }

      const id = newCallId();

      updateCall({
        id,
        status: "calling",
        type,
        peer: { username, conversationId },
        muted: false,
        cameraOff: false,
        startedAt: null,
      });

      try {
        const stream = await getMedia(type);

        // The call may have been cancelled while the permission prompt was open.
        if (callRef.current?.id !== id) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }

        localStreamRef.current = stream;
        setLocalStream(stream);

        const iceServers = await loadIceServers();

        if (callRef.current?.id !== id) return;

        const pc = createPeer(id, iceServers);
        pcRef.current = pc;

        stream.getTracks().forEach((track) => pc.addTrack(track, stream));

        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);

        if (callRef.current?.id !== id) return;

        socket.emit("call:invite", {
          callId: id,
          conversationId,
          callType: type,
          offer: { type: offer.type, sdp: offer.sdp },
        });

        ringTimerRef.current = setTimeout(
          () => endCall("no_answer", END_NOTICES.no_answer),
          RING_TIMEOUT_MS,
        );
      } catch (error) {
        if (callRef.current?.id !== id) return;

        console.error("Start call error:", error);
        finish(mediaErrorMessage(error, type));
      }
    },
    [socket, updateCall, createPeer, endCall, finish, showNotice],
  );

  const acceptCall = useCallback(async () => {
    const current = callRef.current;

    if (!socket || !current || current.status !== "incoming") return;

    updateCall((previous) => previous && { ...previous, status: "connecting" });

    try {
      const stream = await getMedia(current.type);

      if (callRef.current?.id !== current.id) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }

      localStreamRef.current = stream;
      setLocalStream(stream);

      const iceServers = await loadIceServers();

      if (callRef.current?.id !== current.id) return;

      const pc = createPeer(current.id, iceServers);
      pcRef.current = pc;

      stream.getTracks().forEach((track) => pc.addTrack(track, stream));

      await pc.setRemoteDescription(offerRef.current);
      await flushIce();

      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);

      socket.emit("call:answer", {
        callId: current.id,
        answer: { type: answer.type, sdp: answer.sdp },
      });

      markIceReady(current.id);
    } catch (error) {
      if (callRef.current?.id !== current.id) return;

      console.error("Accept call error:", error);
      endCall("failed", mediaErrorMessage(error, current.type));
    }
  }, [socket, updateCall, createPeer, flushIce, endCall, markIceReady]);

  const declineCall = useCallback(() => endCall("declined"), [endCall]);

  const hangUp = useCallback(() => {
    endCall(callRef.current?.status === "calling" ? "cancelled" : "hangup");
  }, [endCall]);

  const toggleMute = useCallback(() => {
    const track = localStreamRef.current?.getAudioTracks()[0];

    if (!track) return;

    track.enabled = !track.enabled;
    updateCall(
      (previous) => previous && { ...previous, muted: !track.enabled },
    );
  }, [updateCall]);

  const toggleCamera = useCallback(() => {
    const track = localStreamRef.current?.getVideoTracks()[0];

    if (!track) return;

    track.enabled = !track.enabled;
    updateCall(
      (previous) => previous && { ...previous, cameraOff: !track.enabled },
    );
  }, [updateCall]);

  // Fetch the call servers ahead of time so the first call starts quickly.
  useEffect(() => {
    if (socket) loadIceServers();
  }, [socket]);

  /* Messages from the server */
  useEffect(() => {
    if (!socket) return;

    function handleIncoming({ callId, callType, conversationId, offer, from }) {
      // Already in a call in this tab.
      if (callRef.current) return;

      offerRef.current = offer;
      pendingIceRef.current = [];

      updateCall({
        id: callId,
        status: "incoming",
        type: callType,
        peer: { username: from.username, conversationId },
        muted: false,
        cameraOff: false,
        startedAt: null,
      });
    }

    function handleRinging({ callId }) {
      if (callRef.current?.id === callId) markIceReady(callId);
    }

    async function handleAnswered({ callId, answer }) {
      if (callRef.current?.id !== callId || !pcRef.current) return;

      clearTimeout(ringTimerRef.current);
      updateCall(
        (previous) => previous && { ...previous, status: "connecting" },
      );

      try {
        await pcRef.current.setRemoteDescription(answer);
        await flushIce();
      } catch (error) {
        console.error("Answer error:", error);
        endCall("failed", END_NOTICES.failed);
      }
    }

    function handleIce({ callId, candidate }) {
      if (callRef.current?.id !== callId) return;

      const pc = pcRef.current;

      if (pc?.remoteDescription) {
        pc.addIceCandidate(candidate).catch((error) =>
          console.warn("ICE candidate error:", error),
        );
      } else {
        pendingIceRef.current.push(candidate);
      }
    }

    // Someone answered on another tab or device.
    function handleTaken({ callId }) {
      const current = callRef.current;

      if (current?.id === callId && current.status === "incoming") {
        finish("");
      }
    }

    function handleEnded({ callId, reason }) {
      const current = callRef.current;

      if (!current || current.id !== callId) return;

      let text = END_NOTICES[reason] ?? "";

      if (
        current.status === "incoming" &&
        ["cancelled", "no_answer", "disconnected"].includes(reason)
      ) {
        text = `Missed call from ${current.peer.username}`;
      }

      finish(text);
    }

    function handleDisconnect() {
      if (callRef.current) finish(END_NOTICES.disconnected);
    }

    socket.on("call:incoming", handleIncoming);
    socket.on("call:ringing", handleRinging);
    socket.on("call:answered", handleAnswered);
    socket.on("call:ice", handleIce);
    socket.on("call:taken", handleTaken);
    socket.on("call:ended", handleEnded);
    socket.on("disconnect", handleDisconnect);

    return () => {
      socket.off("call:incoming", handleIncoming);
      socket.off("call:ringing", handleRinging);
      socket.off("call:answered", handleAnswered);
      socket.off("call:ice", handleIce);
      socket.off("call:taken", handleTaken);
      socket.off("call:ended", handleEnded);
      socket.off("disconnect", handleDisconnect);
    };
  }, [socket, updateCall, finish, endCall, flushIce, markIceReady]);

  // Release the camera and microphone if the page goes away.
  useEffect(() => {
    return () => {
      cleanup();
      clearTimeout(noticeTimerRef.current);
    };
  }, [cleanup]);

  return {
    call,
    localStream,
    remoteStream,
    notice,
    startCall,
    acceptCall,
    declineCall,
    hangUp,
    toggleMute,
    toggleCamera,
  };
}
