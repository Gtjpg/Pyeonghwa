import { useEffect, useMemo, useState, useRef } from "react";
import { io } from "socket.io-client";
import { useNavigate } from "react-router-dom";
import { clearSession } from "../auth";
import Avatar from "../components/Avatar";
import CameraModal from "../components/CameraModal";
import CallOverlay from "../components/CallOverlay";
import {
  CameraIcon,
  CloseIcon,
  ImageIcon,
  PhoneIcon,
  VideoIcon,
} from "../components/icons";
import { useCall } from "../useCall";
import { prepareImage } from "../image";
import { API_URL } from "../config";


/* ---------- Small helpers ---------- */

function PlusIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      className="h-6 w-6"
    >
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

function BackIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-6 w-6"
    >
      <path d="m15 18-6-6 6-6" />
    </svg>
  );
}

function GearIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-6 w-6"
    >
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" />
    </svg>
  );
}

function WarningIcon({ className = "h-4 w-4" }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
      <path d="M12 9v4M12 17h.01" />
    </svg>
  );
}

function CheckIcon({ className = "h-6 w-6" }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d="m5 12 4 4L19 6" />
    </svg>
  );
}

// K7M2QX9D -> K7M2-QX9D
function formatId(id) {
  return id ? id.replace(/(.{4})(?=.)/g, "$1-") : "—";
}

let audioContext;

// Short, quiet two-note ping for new messages
function playPing() {
  try {
    audioContext ??= new (window.AudioContext || window.webkitAudioContext)();

    if (audioContext.state === "suspended") audioContext.resume();

    const now = audioContext.currentTime;
    const oscillator = audioContext.createOscillator();
    const gain = audioContext.createGain();

    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(740, now);
    oscillator.frequency.setValueAtTime(988, now + 0.09);

    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.12, now + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.3);

    oscillator.connect(gain).connect(audioContext.destination);
    oscillator.start(now);
    oscillator.stop(now + 0.32);
  } catch {
    // Sound is optional; ignore if the browser blocks it.
  }
}

/* ---------- Main component ---------- */

// A photo inside the conversation. Tap it to see it full size.
function ChatImage({ src, onOpen, onLoaded }) {
  const [failed, setFailed] = useState(false);

  if (failed) {
    return (
      <div className="flex h-32 w-48 items-center justify-center rounded-2xl bg-slate-800 px-3 text-center text-sm text-slate-400">
        This photo is no longer available
      </div>
    );
  }

  return (
    <button
      onClick={() => onOpen(src)}
      className="max-w-[70%] overflow-hidden rounded-2xl bg-slate-800"
      aria-label="Open photo"
    >
      <img
        src={src}
        alt="Photo"
        onLoad={onLoaded}
        onError={() => setFailed(true)}
        className="block max-h-72 max-w-full object-cover"
      />
    </button>
  );
}

function Chat() {
  const [conversations, setConversations] = useState([]);
  const [activeConversation, setActiveConversation] = useState(null);
  const [socket, setSocket] = useState(null);
  const [messages, setMessages] = useState([]);
  const [messageInput, setMessageInput] = useState("");
  const [showUserSearch, setShowUserSearch] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [unread, setUnread] = useState({});
  const [previews, setPreviews] = useState({});
  const [profile, setProfile] = useState(null);
  const [copied, setCopied] = useState(false);
  const [searchId, setSearchId] = useState("");
  const [searchResult, setSearchResult] = useState(null);
  const [searchStatus, setSearchStatus] = useState("idle");
  const [startingChat, setStartingChat] = useState(false);
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [settingsError, setSettingsError] = useState("");
  const [showPanic, setShowPanic] = useState(false);
  const [panicBusy, setPanicBusy] = useState(false);
  const [panicError, setPanicError] = useState("");

  // Photos and calls
  const [pendingImage, setPendingImage] = useState(null);
  const [sendingImage, setSendingImage] = useState(false);
  const [imageError, setImageError] = useState("");
  const [showCamera, setShowCamera] = useState(false);
  const [viewerImage, setViewerImage] = useState(null);
  const fileInputRef = useRef(null);
  const cameraInputRef = useRef(null);
  const callApi = useCall(socket);

  // Message request state
  const [incomingRequests, setIncomingRequests] = useState([]);
  const [showRequests, setShowRequests] = useState(false);
  const [requestActionBusy, setRequestActionBusy] = useState({});

  // New UI state
  const [acceptedNotice, setAcceptedNotice] = useState(null);
  const [requestSentTo, setRequestSentTo] = useState(null);
  const [sendingRequest, setSendingRequest] = useState(false);

  const messagesEndRef = useRef(null);
  const navigate = useNavigate();

  function logout() {
    clearSession();
    navigate("/", { replace: true });
  }

  // Tracks when each conversation last had activity.
  const [lastActivity, setLastActivity] = useState({});
  const activeConversationRef = useRef(null);
  const conversationsRef = useRef([]);

  useEffect(() => {
    activeConversationRef.current = activeConversation;
  }, [activeConversation]);

  useEffect(() => {
    conversationsRef.current = conversations;
  }, [conversations]);

  function bumpConversation(conversationId) {
    if (conversationId == null) return;

    setLastActivity((previous) => ({
      ...previous,
      [String(conversationId)]: Date.now(),
    }));
  }

  // Most recent conversation first.
  const sortedConversations = useMemo(() => {
    function lastTime(conversation) {
      const local = lastActivity[String(conversation.conversation_id)] || 0;
      const serverValue =
        conversation.last_message_at ?? conversation.updated_at ?? null;
      const server = serverValue ? new Date(serverValue).getTime() : 0;

      return Math.max(local, server || 0);
    }

    return [...conversations].sort((a, b) => lastTime(b) - lastTime(a));
  }, [conversations, lastActivity]);

  // Save chat history is on only when every conversation is saving.
  const historyEnabled =
    conversations.length === 0 || conversations.every((c) => c.keep_history);

  const totalUnread = useMemo(
    () => Object.values(unread).reduce((sum, count) => sum + count, 0),
    [unread],
  );

  function clearUnread(conversationId) {
    setUnread((previous) => {
      const next = { ...previous };
      delete next[String(conversationId)];
      return next;
    });
  }

  // Show unread total in the browser tab title.
  useEffect(() => {
    document.title =
      totalUnread > 0 ? `(${totalUnread}) Pyeonghwa` : "Pyeonghwa";
  }, [totalUnread]);

  // Clear the badge and tell the server this chat has been read.
  function markRead(conversationId) {
    clearUnread(conversationId);

    fetch(`${API_URL}/conversations/${conversationId}/read`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${sessionStorage.getItem("token")}`,
      },
    }).catch((error) => console.error("Mark read error:", error));
  }

  // Coming back to the tab counts as reading the open chat.
  useEffect(() => {
    function handleVisibility() {
      const active = activeConversationRef.current;

      if (!document.hidden && active) {
        markRead(active.conversation_id);
      }
    }

    document.addEventListener("visibilitychange", handleVisibility);

    return () =>
      document.removeEventListener("visibilitychange", handleVisibility);
  }, []);

  const currentUser = useMemo(() => {
    try {
      return JSON.parse(sessionStorage.getItem("user"));
    } catch {
      return null;
    }
  }, []);

  /* Load conversations */
  async function loadConversations() {
    try {
      const token = sessionStorage.getItem("token");

      const response = await fetch(`${API_URL}/conversations`, {
        headers: { Authorization: `Bearer ${token}` },
      });

      if (response.status === 401 || response.status === 403) {
        logout();
        return;
      }

      if (!response.ok) {
        throw new Error("Failed to load conversations");
      }

      const data = await response.json();

      setConversations(data);

      setUnread(
        Object.fromEntries(
          data
            .filter((c) => c.unread_count > 0)
            .map((c) => [String(c.conversation_id), c.unread_count]),
        ),
      );

      return data;
    } catch (error) {
      console.error("Conversation loading error:", error);
    }
  }

  /* Load incoming message requests */
  async function loadIncomingRequests() {
    try {
      const response = await fetch(
        `${API_URL}/message-requests/incoming`,
        {
          headers: {
            Authorization: `Bearer ${sessionStorage.getItem("token")}`,
          },
        },
      );

      if (response.status === 401) {
        logout();
        return;
      }

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.message || "Failed to load message requests");
      }

      setIncomingRequests(
        (Array.isArray(data) ? data : data.requests || []).map((request) => ({
          ...request,
          id: request.request_id ?? request.id,
          username: request.sender_username ?? request.username,
          public_id: request.sender_public_id ?? request.public_id,
        })),
      );
    } catch (error) {
      console.error("Incoming requests error:", error);
    }
  }

  useEffect(() => {
    loadConversations();
    loadIncomingRequests();
  }, []);

  /* Join room when conversation changes */
  useEffect(() => {
    if (!socket || !activeConversation) return;

    const room = `conversation_${activeConversation.conversation_id}`;

    socket.emit("join_room", room);
    console.log("Joining room:", room);
  }, [socket, activeConversation]);

  /* Chat history */
  useEffect(() => {
    if (!socket) return;

    function handleChatHistory(history) {
      setMessages(history);
    }

    socket.on("chat_history", handleChatHistory);

    return () => socket.off("chat_history", handleChatHistory);
  }, [socket]);

  /* Socket connection */
  useEffect(() => {
    const token = sessionStorage.getItem("token");

    if (!token) {
      console.error("No login token found.");
      return;
    }

    const newSocket = io(API_URL, {
      auth: { token },
    });

    newSocket.on("connect", () => {
      console.log("Socket connected:", newSocket.id);
    });

    newSocket.on("connect_error", (error) => {
      console.error("Socket connection error:", error.message);

      if (
        error.message === "Invalid token" ||
        error.message === "No token provided"
      ) {
        logout();
      }
    });

    setSocket(newSocket);

    return () => newSocket.disconnect();
  }, []);

  /* Real-time message request updates */
  useEffect(() => {
    if (!socket) return;

    function handleRequestReceived() {
      loadIncomingRequests();
    }

    function handleRequestAccepted(data = {}) {
      // Refresh the conversation list for both users.
      loadConversations();

      // Only the original requester should see this notification.
      if (Number(currentUser?.id) !== Number(data.requesterId)) {
        return;
      }

      setAcceptedNotice({
        username: data.username || "Someone",
        id: Date.now(),
      });
    }

    function handleRequestRejected() {
      console.log("Your message request was rejected.");
    }

    socket.on("message_request_received", handleRequestReceived);
    socket.on("message_request_accepted", handleRequestAccepted);
    socket.on("message_request_rejected", handleRequestRejected);

    return () => {
      socket.off("message_request_received", handleRequestReceived);
      socket.off("message_request_accepted", handleRequestAccepted);
      socket.off("message_request_rejected", handleRequestRejected);
    };
  }, [socket]);

  /* Live messages */
  useEffect(() => {
    if (!socket) return;

    function handleNewMessage(message) {
      const conversationId = message.room
        ? String(message.room).replace("conversation_", "")
        : activeConversationRef.current?.conversation_id;

      bumpConversation(conversationId);

      // Ignore messages belonging to a different chat.
      if (
        String(conversationId) !==
        String(activeConversationRef.current?.conversation_id)
      ) {
        return;
      }

      setMessages((previous) => [
        ...previous,
        {
          id: `${Date.now()}-${Math.random()}`,
          username: message.username,
          content: message.message,
          message_type: message.type || "text",
          image_url: message.imageUrl || null,
        },
      ]);
    }

    socket.on("chat_message", handleNewMessage);

    return () => socket.off("chat_message", handleNewMessage);
  }, [socket]);

  /* Activity in any conversation */
  useEffect(() => {
    if (!socket) return;

    function handleActivity({ conversationId, username, message }) {
      const id = String(conversationId);
      const mine = username === currentUser?.username;

      bumpConversation(conversationId);

      setPreviews((previous) => ({
        ...previous,
        [id]: { text: message, mine },
      }));

      const isBeingViewed =
        String(activeConversationRef.current?.conversation_id) === id &&
        !document.hidden;

      if (!mine && !isBeingViewed) {
        setUnread((previous) => ({
          ...previous,
          [id]: (previous[id] || 0) + 1,
        }));

        playPing();
      } else if (!mine) {
        markRead(id);
      }

      const known = conversationsRef.current.some(
        (c) => String(c.conversation_id) === String(conversationId),
      );

      if (!known) loadConversations();
    }

    socket.on("conversation_activity", handleActivity);

    return () => socket.off("conversation_activity", handleActivity);
  }, [socket]);

  /* Someone used the panic button */
  useEffect(() => {
    if (!socket) return;

    function handleCleared({ room }) {
      const id = String(room).replace("conversation_", "");

      setPreviews((previous) => ({ ...previous, [id]: null }));
      clearUnread(id);

      const active = activeConversationRef.current;

      if (active && room === `conversation_${active.conversation_id}`) {
        setMessages([]);
      }
    }

    socket.on("history_cleared", handleCleared);

    return () => socket.off("history_cleared", handleCleared);
  }, [socket]);

  /* Auto-scroll */
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, activeConversation]);

  function openProfile(user) {
    setCopied(false);
    setProfile(user);
  }

  async function copyId(value) {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (error) {
      console.error("Copy error:", error);
    }
  }

  function closeSearch() {
    setShowUserSearch(false);
    setSearchId("");
    setSearchResult(null);
    setSearchStatus("idle");
    setRequestSentTo(null);
    setSendingRequest(false);
  }

  async function searchUser(rawId) {
    const id = rawId.toUpperCase().replace(/[^A-Z0-9]/g, "");

    if (id.length !== 8) return;

    setSearchStatus("loading");
    setSearchResult(null);

    try {
      const response = await fetch(
        `${API_URL}/users/search?id=${encodeURIComponent(id)}`,
        {
          headers: {
            Authorization: `Bearer ${sessionStorage.getItem("token")}`,
          },
        },
      );

      if (response.status === 401 || response.status === 403) {
        logout();
        return;
      }

      if (response.status === 404) {
        setSearchStatus("notfound");
        return;
      }

      if (!response.ok) {
        throw new Error("Search failed");
      }

      setSearchResult(await response.json());
      setSearchStatus("found");
    } catch (error) {
      console.error("User search error:", error);
      setSearchStatus("error");
    }
  }

  /* Send a message request */
  async function sendMessageRequest(targetUserId) {
    if (sendingRequest) return;

    setSendingRequest(true);

    try {
      const response = await fetch(`${API_URL}/message-requests`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${sessionStorage.getItem("token")}`,
        },
        body: JSON.stringify({ targetUserId }),
      });

      if (response.status === 401 || response.status === 403) {
        logout();
        return;
      }

      const data = await response.json();

      if (!response.ok) {
        console.error("Send message request failed:", data.message);
        setSearchStatus("sendError");
        return;
      }

      setRequestSentTo({
        username: searchResult?.user?.username || "your new contact",
        public_id: searchResult?.user?.public_id,
      });

      setSearchStatus("sent");
    } catch (error) {
      console.error("Send message request error:", error);
      setSearchStatus("sendError");
    } finally {
      setSendingRequest(false);
    }
  }

  /* Accept or reject an incoming request */
  async function respondToRequest(requestId, action) {
    setRequestActionBusy((previous) => ({
      ...previous,
      [requestId]: true,
    }));

    try {
      const response = await fetch(
        `${API_URL}/message-requests/${requestId}/respond`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${sessionStorage.getItem("token")}`,
          },
          body: JSON.stringify({ action }),
        },
      );

      if (response.status === 401) {
        logout();
        return;
      }

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.message || "Could not respond to request");
      }

      // Remove the request from the pending list.
      setIncomingRequests((previous) =>
        previous.filter((request) => String(request.id) !== String(requestId)),
      );

      if (action === "accept") {
        const list = await loadConversations();

        const conversationId =
          data.conversation?.conversationId ??
          data.conversation?.conversation_id ??
          data.conversationId;

        const conversation = list?.find(
          (item) => String(item.conversation_id) === String(conversationId),
        );

        if (conversation) {
          setShowRequests(false);
          openConversation(conversation);
        } else {
          console.warn(
            "Request accepted, but the conversation was not found in the refreshed list.",
          );

          alert(
            "Request accepted! If the conversation doesn't appear yet, refresh the page.",
          );
        }
      }
    } catch (error) {
      console.error("Respond to request error:", error);
      alert(error.message || "Could not respond to request");
      loadIncomingRequests();
    } finally {
      setRequestActionBusy((previous) => ({
        ...previous,
        [requestId]: false,
      }));
    }
  }

  function handleSearchChange(value) {
    const cleaned = value
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, "")
      .slice(0, 8);

    setSearchId(cleaned);
    setSearchResult(null);
    setSearchStatus("idle");
    setRequestSentTo(null);

    if (cleaned.length === 8) searchUser(cleaned);
  }

  // Kept for compatibility with existing conversations.
  // New conversations must begin with an accepted request.
  async function startChat(user) {
    setStartingChat(true);

    try {
      const response = await fetch(`${API_URL}/conversations`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${sessionStorage.getItem("token")}`,
        },
        body: JSON.stringify({ targetUserId: user.id }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(
          data.message || "A message request must be accepted first.",
        );
      }

      const conversationId =
        data.conversationId ?? data.conversation?.conversationId;

      const list = await loadConversations();

      const conversation = list?.find(
        (c) => String(c.conversation_id) === String(conversationId),
      );

      if (conversation) openConversation(conversation);

      closeSearch();
    } catch (error) {
      console.error("Start chat error:", error);
      setSearchStatus("error");
    } finally {
      setStartingChat(false);
    }
  }

  async function toggleHistory() {
    const next = !historyEnabled;

    setSettingsBusy(true);
    setSettingsError("");

    try {
      const response = await fetch(`${API_URL}/settings/history`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${sessionStorage.getItem("token")}`,
        },
        body: JSON.stringify({ keepHistory: next }),
      });

      if (!response.ok) {
        throw new Error("Request failed");
      }

      setConversations((previous) =>
        previous.map((c) => ({
          ...c,
          keep_history: next,
          ...(next
            ? {}
            : { last_message_text: null, last_message_sender: null }),
        })),
      );
    } catch (error) {
      console.error("Settings error:", error);
      setSettingsError("Couldn't update this setting. Please try again.");
    } finally {
      setSettingsBusy(false);
    }
  }

  async function deleteAllHistory() {
    setPanicBusy(true);
    setPanicError("");

    try {
      const response = await fetch(`${API_URL}/messages`, {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${sessionStorage.getItem("token")}`,
        },
      });

      if (!response.ok) {
        throw new Error("Request failed");
      }

      setMessages([]);
      setShowPanic(false);
    } catch (error) {
      console.error("Panic delete error:", error);
      setPanicError("Couldn't delete your chat history. Please try again.");
    } finally {
      setPanicBusy(false);
    }
  }

  function scrollToBottom() {
    messagesEndRef.current?.scrollIntoView({ behavior: "auto" });
  }

  function closePendingImage() {
    if (pendingImage) URL.revokeObjectURL(pendingImage.url);

    setPendingImage(null);
    setImageError("");
  }

  async function handleImageChosen(file, source) {
    setImageError("");

    try {
      const blob = await prepareImage(file);

      setPendingImage({ blob, url: URL.createObjectURL(blob), source });
    } catch (error) {
      console.error("Image error:", error);
      setImageError("That file couldn't be read as a photo.");
    }
  }

  function openCamera() {
    if (navigator.mediaDevices?.getUserMedia) {
      setShowCamera(true);
    } else {
      // Phones can still open their camera app this way.
      cameraInputRef.current?.click();
    }
  }

  function handleCameraCapture(blob) {
    setShowCamera(false);
    handleImageChosen(blob, "camera");
  }

  async function sendPendingImage() {
    if (!pendingImage || !activeConversation || !socket) return;

    const conversationId = activeConversation.conversation_id;

    setSendingImage(true);
    setImageError("");

    try {
      const form = new FormData();
      form.append("image", pendingImage.blob, "photo.jpg");

      const response = await fetch(
        `${API_URL}/conversations/${conversationId}/images`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${sessionStorage.getItem("token")}`,
          },
          body: form,
        },
      );

      if (response.status === 401 || response.status === 403) {
        logout();
        return;
      }

      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(data.message || "Couldn't send the photo.");
      }

      socket.emit("chat_message", {
        room: `conversation_${conversationId}`,
        type: "image",
        imageUrl: data.url,
      });

      bumpConversation(conversationId);
      closePendingImage();
    } catch (error) {
      console.error("Send photo error:", error);
      setImageError(error.message || "Couldn't send the photo.");
    } finally {
      setSendingImage(false);
    }
  }

  function startCallWith(type) {
    if (!activeConversation) return;

    callApi.startCall({
      conversationId: activeConversation.conversation_id,
      username: activeConversation.username,
      type,
    });
  }

  function openConversation(conversation) {
    markRead(conversation.conversation_id);
    setMessages([]);
    setActiveConversation(conversation);
  }

  function closeConversation() {
    setActiveConversation(null);
    setMessages([]);
  }

  function sendMessage() {
    if (!socket || !activeConversation) return;

    const message = messageInput.trim();

    if (!message) return;

    const room = `conversation_${activeConversation.conversation_id}`;

    socket.emit("chat_message", { room, message });

    bumpConversation(activeConversation.conversation_id);
    setMessageInput("");
  }

  return (
    <div className="flex h-dvh w-full overflow-hidden bg-slate-950 text-white">
      {/* ================= Accepted request notification ================= */}
      {acceptedNotice && (
        <div className="fixed left-1/2 top-5 z-100 w-[calc(100%-2rem)] max-w-md -translate-x-1/2 animate-in fade-in slide-in-from-top-3 duration-300">
          <div className="flex items-start gap-3 rounded-2xl border border-emerald-400/30 bg-slate-900/95 p-4 shadow-2xl shadow-emerald-950/40 backdrop-blur-xl">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-emerald-400/15 text-emerald-400">
              <CheckIcon className="h-6 w-6" />
            </div>

            <div className="min-w-0 flex-1">
              <p className="font-bold text-white">Message request accepted!</p>

              <p className="mt-1 text-sm leading-5 text-slate-300">
                {acceptedNotice.username} accepted your message request! You can
                start chatting now.
              </p>

              <button
                onClick={() => {
                  loadConversations();
                  setAcceptedNotice(null);
                }}
                className="mt-3 rounded-lg bg-emerald-400 px-4 py-2 text-sm font-bold text-slate-950 transition hover:bg-emerald-300"
              >
                Got it
              </button>
            </div>

            <button
              onClick={() => setAcceptedNotice(null)}
              className="rounded-lg px-2 py-1 text-slate-400 transition hover:bg-white/10 hover:text-white"
              aria-label="Dismiss notification"
            >
              ✕
            </button>
          </div>
        </div>
      )}

      {/* ================= Conversation list ================= */}
      <aside
        className={`${
          activeConversation ? "hidden" : "flex"
        } w-full flex-col md:flex md:w-80 md:shrink-0 md:border-r md:border-slate-800`}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 pb-1 pt-5">
          <div>
            <h1 className="text-2xl font-bold">Pyeonghwa</h1>
            <p className="text-sm text-slate-400">Private conversations</p>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={() => {
                setSettingsError("");
                setShowSettings(true);
              }}
              className="rounded-full bg-slate-900 p-2 text-slate-300 hover:bg-slate-800 hover:text-white"
              aria-label="Settings"
            >
              <GearIcon />
            </button>

            <button
              onClick={() => setShowUserSearch(true)}
              className="rounded-full bg-slate-900 p-2 text-slate-300 hover:bg-slate-800 hover:text-white"
              aria-label="Start a new chat"
            >
              <PlusIcon />
            </button>
          </div>
        </div>

        {/* My profile */}
        <button
          onClick={() =>
            openProfile({
              username: currentUser?.username,
              public_id: currentUser?.public_id,
              isMe: true,
            })
          }
          className="mx-5 mt-4 flex items-center gap-3 rounded-xl bg-slate-900 px-3 py-2.5 text-left hover:bg-slate-800"
        >
          <Avatar
            name={currentUser?.username}
            size="h-10 w-10"
            text="text-sm"
          />

          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold">
              {currentUser?.username}
            </p>
            <p className="truncate font-mono text-xs tracking-wider text-slate-400">
              ID {formatId(currentUser?.public_id)}
            </p>
          </div>
        </button>

        {/* Message Requests */}
        <button
          onClick={() => {
            setShowRequests(true);
            loadIncomingRequests();
          }}
          className="mx-5 mt-3 flex items-center justify-between rounded-xl bg-slate-900 px-4 py-3 text-left hover:bg-slate-800"
        >
          <span className="font-medium">Message Requests</span>

          {incomingRequests.length > 0 && (
            <span className="flex h-6 min-w-6 items-center justify-center rounded-full bg-teal-500 px-2 text-xs font-bold text-slate-950">
              {incomingRequests.length > 99 ? "99+" : incomingRequests.length}
            </span>
          )}
        </button>

        <h2 className="px-5 pb-2 pt-6 text-sm font-semibold text-slate-400">
          Messages
        </h2>

        {/* Conversation list */}
        <div className="flex-1 overflow-y-auto">
          {conversations.length === 0 ? (
            <p className="px-5 py-4 text-sm text-slate-500">
              No conversations yet.
            </p>
          ) : (
            sortedConversations.map((conversation) => {
              const isActive =
                String(activeConversation?.conversation_id) ===
                String(conversation.conversation_id);

              const id = String(conversation.conversation_id);
              const count = unread[id] || 0;

              const preview =
                id in previews
                  ? previews[id]
                  : conversation.last_message_text
                    ? {
                        text: conversation.last_message_text,
                        mine:
                          conversation.last_message_sender ===
                          currentUser?.username,
                      }
                    : null;

              return (
                <button
                  key={conversation.conversation_id}
                  onClick={() => openConversation(conversation)}
                  className={`flex w-full items-center gap-3 px-5 py-3 text-left ${
                    isActive ? "bg-slate-800" : "hover:bg-slate-900"
                  }`}
                >
                  <Avatar name={conversation.username} />

                  <div className="min-w-0 flex-1">
                    <p
                      className={`truncate ${
                        count > 0 ? "font-bold text-white" : "font-medium"
                      }`}
                    >
                      {conversation.username}
                    </p>

                    {preview && (
                      <p
                        className={`truncate text-sm ${
                          count > 0
                            ? "font-semibold text-white"
                            : "text-slate-500"
                        }`}
                      >
                        {preview.mine ? "You: " : ""}
                        {preview.text}
                      </p>
                    )}
                  </div>

                  {count > 0 && (
                    <span className="flex h-6 min-w-6 shrink-0 items-center justify-center rounded-full bg-teal-500 px-2 text-xs font-bold text-slate-950">
                      {count > 99 ? "99+" : count}
                    </span>
                  )}
                </button>
              );
            })
          )}
        </div>
      </aside>

      {/* ================= Chat panel ================= */}
      <main
        className={`${
          activeConversation ? "flex" : "hidden"
        } min-h-0 min-w-0 flex-1 flex-col md:flex`}
      >
        {!activeConversation ? (
          <div className="flex h-full flex-col items-center justify-center px-6 text-center">
            <div className="mb-4 text-5xl">💬</div>
            <h2 className="mb-2 text-xl font-semibold">Your space to chat</h2>
            <p className="mb-5 text-sm text-slate-400">
              Select a conversation to view messages.
            </p>
            <button
              onClick={() => setShowUserSearch(true)}
              className="rounded-xl bg-teal-600 px-5 py-3 font-semibold transition hover:bg-teal-500"
            >
              Search users
            </button>
          </div>
        ) : (
          <>
            {/* Chat header */}
            <header className="flex shrink-0 items-center gap-3 border-b border-slate-800 px-3 py-3 md:px-5">
              <button
                onClick={closeConversation}
                className="rounded-full p-1 hover:bg-slate-800 md:hidden"
                aria-label="Back to messages"
              >
                <BackIcon />
              </button>

              <button
                onClick={() =>
                  openProfile({
                    username: activeConversation.username,
                    public_id: activeConversation.public_id,
                    isMe: false,
                  })
                }
                className="flex min-w-0 flex-1 items-center gap-3 rounded-lg text-left hover:opacity-80"
                aria-label={`View ${activeConversation.username}'s profile`}
              >
                <Avatar
                  name={activeConversation.username}
                  size="h-9 w-9"
                  text="text-sm"
                />

                <h2 className="truncate font-semibold">
                  {activeConversation.username}
                </h2>
              </button>

              <button
                onClick={() => startCallWith("audio")}
                disabled={!!callApi.call}
                className="shrink-0 rounded-full p-2 text-slate-300 hover:bg-slate-800 hover:text-white disabled:opacity-40"
                aria-label="Start a voice call"
                title="Voice call"
              >
                <PhoneIcon className="h-5 w-5" />
              </button>

              <button
                onClick={() => startCallWith("video")}
                disabled={!!callApi.call}
                className="shrink-0 rounded-full p-2 text-slate-300 hover:bg-slate-800 hover:text-white disabled:opacity-40"
                aria-label="Start a video call"
                title="Video call"
              >
                <VideoIcon className="h-5 w-5" />
              </button>

              <button
                onClick={() => {
                  setPanicError("");
                  setShowPanic(true);
                }}
                className="flex shrink-0 items-center gap-1.5 rounded-lg bg-red-600/15 px-3 py-1.5 text-sm font-semibold text-red-400 hover:bg-red-600/25"
                aria-label="Panic"
              >
                <WarningIcon />
                <span className="hidden sm:inline">Panic</span>
              </button>
            </header>

            {/* Messages */}
            <section className="min-h-0 flex-1 space-y-2 overflow-y-auto px-4 py-4 md:px-6">
              {messages.length === 0 ? (
                <div className="flex h-full items-center justify-center text-center">
                  <p className="text-sm text-slate-400">
                    No saved messages in this conversation yet.
                  </p>
                </div>
              ) : (
                messages.map((msg) => {
                  const isMine = msg.username === currentUser?.username;

                  return (
                    <div
                      key={msg.id}
                      className={`flex items-start gap-2 ${
                        isMine ? "flex-row-reverse" : "flex-row"
                      }`}
                    >
                      <button
                        onClick={() =>
                          openProfile(
                            isMine
                              ? {
                                  username: currentUser?.username,
                                  public_id: currentUser?.public_id,
                                  isMe: true,
                                }
                              : {
                                  username: activeConversation.username,
                                  public_id: activeConversation.public_id,
                                  isMe: false,
                                },
                          )
                        }
                        className="shrink-0 rounded-full"
                        aria-label={`View ${msg.username}'s profile`}
                      >
                        <Avatar
                          name={msg.username}
                          size="h-9 w-9"
                          text="text-sm"
                        />
                      </button>

                      {msg.message_type === "image" && msg.image_url ? (
                        <ChatImage
                          src={`${API_URL}${msg.image_url}`}
                          onOpen={setViewerImage}
                          onLoaded={scrollToBottom}
                        />
                      ) : (
                        <div
                          className={`max-w-[70%] wrap-break-word rounded-2xl px-4 py-2 ${
                            isMine
                              ? "rounded-br-sm bg-teal-600 text-white"
                              : "rounded-bl-sm bg-slate-800 text-slate-100"
                          }`}
                        >
                          {msg.content ?? msg.message}
                        </div>
                      )}
                    </div>
                  );
                })
              )}

              <div ref={messagesEndRef} />
            </section>

            {/* Message input */}
            <footer className="shrink-0 border-t border-slate-800 bg-slate-950 p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] md:p-4">
              {imageError && !pendingImage && (
                <p className="mb-2 text-sm text-red-400">{imageError}</p>
              )}

              <div className="flex gap-2">
                <button
                  onClick={() => fileInputRef.current?.click()}
                  className="shrink-0 self-center rounded-full p-2 text-slate-300 hover:bg-slate-800 hover:text-white"
                  aria-label="Send a photo"
                  title="Send a photo"
                >
                  <ImageIcon />
                </button>

                <button
                  onClick={openCamera}
                  className="shrink-0 self-center rounded-full p-2 text-slate-300 hover:bg-slate-800 hover:text-white"
                  aria-label="Take a photo"
                  title="Take a photo"
                >
                  <CameraIcon />
                </button>

                <input
                  type="text"
                  placeholder="Write a message..."
                  value={messageInput}
                  onChange={(e) => setMessageInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") sendMessage();
                  }}
                  className="min-w-0 flex-1 rounded-lg border border-slate-800 bg-slate-900 p-3 text-base outline-none focus:border-teal-500"
                />

                <button
                  onClick={sendMessage}
                  disabled={!messageInput.trim()}
                  className="rounded-lg bg-teal-600 px-5 font-semibold disabled:opacity-50"
                >
                  Send
                </button>
              </div>

              {/* Hidden pickers */}
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.target.value = "";
                  if (file) handleImageChosen(file, "file");
                }}
              />

              <input
                ref={cameraInputRef}
                type="file"
                accept="image/*"
                capture="environment"
                className="hidden"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.target.value = "";
                  if (file) handleImageChosen(file, "camera");
                }}
              />
            </footer>
          </>
        )}
      </main>

      {/* ================= Photo preview ================= */}
      {pendingImage && (
        <div className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-black/85 p-4">
          <img
            src={pendingImage.url}
            alt="Photo to send"
            className="max-h-[70dvh] max-w-full rounded-2xl object-contain"
          />

          {imageError && (
            <p className="mt-3 text-sm text-red-400">{imageError}</p>
          )}

          <div className="mt-5 flex w-full max-w-sm gap-3">
            <button
              onClick={closePendingImage}
              disabled={sendingImage}
              className="flex-1 rounded-lg bg-slate-800 py-3 font-semibold hover:bg-slate-700 disabled:opacity-50"
            >
              Cancel
            </button>

            {pendingImage.source === "camera" && (
              <button
                onClick={() => {
                  closePendingImage();
                  openCamera();
                }}
                disabled={sendingImage}
                className="flex-1 rounded-lg bg-slate-800 py-3 font-semibold hover:bg-slate-700 disabled:opacity-50"
              >
                Retake
              </button>
            )}

            <button
              onClick={sendPendingImage}
              disabled={sendingImage}
              className="flex-1 rounded-lg bg-teal-600 py-3 font-semibold hover:bg-teal-500 disabled:opacity-50"
            >
              {sendingImage ? "Sending..." : "Send"}
            </button>
          </div>
        </div>
      )}

      {showCamera && (
        <CameraModal
          onCapture={handleCameraCapture}
          onClose={() => setShowCamera(false)}
        />
      )}

      {viewerImage && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/90 p-4"
          onClick={() => setViewerImage(null)}
        >
          <button
            onClick={() => setViewerImage(null)}
            className="absolute right-4 top-4 rounded-full bg-white/10 p-2 text-white hover:bg-white/20"
            aria-label="Close photo"
          >
            <CloseIcon />
          </button>

          <img
            src={viewerImage}
            alt="Photo"
            className="max-h-full max-w-full object-contain"
            onClick={(event) => event.stopPropagation()}
          />
        </div>
      )}

      {/* ================= Settings modal ================= */}
      {showSettings && (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 md:items-center md:p-4"
          onClick={() => setShowSettings(false)}
        >
          <div
            className="w-full rounded-t-2xl border border-slate-700 bg-slate-900 p-6 shadow-2xl md:max-w-md md:rounded-2xl"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="mb-5 flex items-center justify-between">
              <h2 className="text-xl font-bold">Settings</h2>

              <button
                onClick={() => setShowSettings(false)}
                className="rounded-lg px-3 py-1 text-slate-400 hover:bg-slate-800 hover:text-white"
                aria-label="Close settings"
              >
                ✕
              </button>
            </div>

            <div className="flex items-center justify-between gap-4 rounded-xl bg-slate-950 p-4">
              <div>
                <p className="font-semibold">Save chat history</p>
                <p className="mt-1 text-sm text-slate-400">
                  {historyEnabled
                    ? "New messages are saved and show up when you reopen a chat."
                    : "New messages aren't saved. They disappear when you close the chat, and photos are deleted from the server after an hour."}
                </p>
              </div>

              <button
                role="switch"
                aria-checked={historyEnabled}
                aria-label="Save chat history"
                onClick={toggleHistory}
                disabled={settingsBusy}
                className={`relative h-7 w-12 shrink-0 rounded-full transition disabled:opacity-60 ${
                  historyEnabled ? "bg-teal-600" : "bg-slate-700"
                }`}
              >
                <span
                  className={`absolute top-0.5 h-6 w-6 rounded-full bg-white transition-all ${
                    historyEnabled ? "left-5.5" : "left-0.5"
                  }`}
                />
              </button>
            </div>

            <p className="mt-3 text-sm text-slate-500">
              This applies to all of your conversations, including the other
              person's side.
            </p>

            {settingsError && (
              <p className="mt-3 text-sm text-red-400">{settingsError}</p>
            )}

            <button
              onClick={logout}
              className="mt-5 w-full rounded-lg bg-slate-800 py-3 font-semibold hover:bg-slate-700"
            >
              Log out
            </button>
          </div>
        </div>
      )}

      {/* ================= Message Requests modal ================= */}
      {showRequests && (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 md:items-center md:p-4"
          onClick={() => setShowRequests(false)}
        >
          <div
            className="w-full rounded-t-2xl border border-slate-700 bg-slate-900 p-6 shadow-2xl md:max-w-md md:rounded-2xl"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="mb-5 flex items-center justify-between">
              <div>
                <h2 className="text-xl font-bold">Message Requests</h2>
                <p className="mt-1 text-sm text-slate-400">
                  Accept a request to start a conversation.
                </p>
              </div>

              <button
                onClick={() => setShowRequests(false)}
                className="rounded-lg px-3 py-1 text-slate-400 hover:bg-slate-800 hover:text-white"
                aria-label="Close message requests"
              >
                ✕
              </button>
            </div>

            <div className="max-h-[60dvh] space-y-3 overflow-y-auto">
              {incomingRequests.length === 0 ? (
                <p className="py-8 text-center text-sm text-slate-400">
                  No pending message requests.
                </p>
              ) : (
                incomingRequests.map((request) => (
                  <div
                    key={request.id}
                    className="flex items-center gap-3 rounded-xl bg-slate-950 p-3"
                  >
                    <Avatar
                      name={request.username || "?"}
                      size="h-11 w-11"
                      text="text-sm"
                    />

                    <div className="min-w-0 flex-1">
                      <p className="truncate font-semibold">
                        {request.username || "Unknown user"}
                      </p>

                      <p className="truncate font-mono text-xs text-slate-400">
                        {formatId(request.public_id)}
                      </p>
                    </div>

                    <div className="flex shrink-0 flex-col gap-2">
                      <button
                        onClick={() => respondToRequest(request.id, "accept")}
                        disabled={Boolean(requestActionBusy[request.id])}
                        className="rounded-lg bg-teal-600 px-3 py-1.5 text-sm font-semibold hover:bg-teal-500 disabled:opacity-50"
                      >
                        {requestActionBusy[request.id]
                          ? "Please wait..."
                          : "Accept"}
                      </button>

                      <button
                        onClick={() => respondToRequest(request.id, "reject")}
                        disabled={Boolean(requestActionBusy[request.id])}
                        className="rounded-lg bg-slate-800 px-3 py-1.5 text-sm font-semibold text-slate-300 hover:bg-slate-700 disabled:opacity-50"
                      >
                        Reject
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}

      {/* ================= Panic modal ================= */}
      {showPanic && (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 md:items-center md:p-4"
          onClick={() => !panicBusy && setShowPanic(false)}
        >
          <div
            className="w-full rounded-t-2xl border border-red-900/60 bg-slate-900 p-6 shadow-2xl md:max-w-md md:rounded-2xl"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="mb-3 flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-red-600/20 text-red-400">
                <WarningIcon className="h-5 w-5" />
              </div>

              <h2 className="text-xl font-bold">Delete all chat history?</h2>
            </div>

            <p className="text-sm text-slate-300">
              This permanently deletes every saved message in all of your
              conversations. The messages are removed for the people you've
              talked to as well, and this can't be undone.
            </p>

            {panicError && (
              <p className="mt-3 text-sm text-red-400">{panicError}</p>
            )}

            <div className="mt-6 flex gap-3">
              <button
                onClick={() => setShowPanic(false)}
                disabled={panicBusy}
                className="flex-1 rounded-lg bg-slate-800 py-3 font-semibold hover:bg-slate-700 disabled:opacity-50"
              >
                Cancel
              </button>

              <button
                onClick={deleteAllHistory}
                disabled={panicBusy}
                className="flex-1 rounded-lg bg-red-600 py-3 font-semibold hover:bg-red-500 disabled:opacity-50"
              >
                {panicBusy ? "Deleting..." : "Delete everything"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ================= Profile modal ================= */}
      {profile && (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 md:items-center md:p-4"
          onClick={() => setProfile(null)}
        >
          <div
            className="w-full rounded-t-2xl border border-slate-700 bg-slate-900 p-6 shadow-2xl md:max-w-sm md:rounded-2xl"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex justify-end">
              <button
                onClick={() => setProfile(null)}
                className="rounded-lg px-3 py-1 text-slate-400 hover:bg-slate-800 hover:text-white"
                aria-label="Close profile"
              >
                ✕
              </button>
            </div>

            <div className="flex flex-col items-center text-center">
              <Avatar
                name={profile.username}
                size="h-24 w-24"
                text="text-4xl"
              />

              <h2 className="mt-4 text-xl font-bold">{profile.username}</h2>

              {profile.isMe && (
                <p className="text-sm text-slate-400">This is you</p>
              )}
            </div>

            <div className="mt-6 rounded-xl bg-slate-950 p-4">
              <p className="text-sm text-slate-400">User ID</p>

              <div className="mt-1 flex items-center justify-between gap-3">
                <p className="font-mono text-lg font-semibold tracking-widest">
                  {formatId(profile.public_id)}
                </p>

                {profile.public_id && (
                  <button
                    onClick={() => copyId(formatId(profile.public_id))}
                    className="rounded-lg bg-slate-800 px-3 py-1.5 text-sm font-semibold hover:bg-slate-700"
                  >
                    {copied ? "Copied" : "Copy"}
                  </button>
                )}
              </div>
            </div>

            {profile.isMe && (
              <p className="mt-3 text-sm text-slate-500">
                Share this ID so people can find you and start a chat.
              </p>
            )}
          </div>
        </div>
      )}

      {/* ================= Search modal ================= */}
      {showUserSearch && (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 backdrop-blur-sm md:items-center md:p-4"
          onClick={closeSearch}
        >
          <div
            className="w-full overflow-hidden rounded-t-3xl border border-slate-700 bg-slate-900 shadow-2xl md:max-w-md md:rounded-3xl"
            onClick={(event) => event.stopPropagation()}
          >
            {/* Search modal header */}
            <div className="flex items-center justify-between border-b border-slate-800 px-6 py-5">
              <div>
                <h2 className="text-xl font-bold">Find someone</h2>
                <p className="mt-1 text-sm text-slate-400">
                  Connect with people using their ID.
                </p>
              </div>

              <button
                onClick={closeSearch}
                className="rounded-xl bg-slate-800 px-3 py-2 text-slate-400 transition hover:bg-slate-700 hover:text-white"
                aria-label="Close search popup"
              >
                ✕
              </button>
            </div>

            <div className="p-6">
              {/* Successful request screen */}
              {searchStatus === "sent" && requestSentTo ? (
                <div className="py-3 text-center">
                  <div className="mx-auto flex h-20 w-20 items-center justify-center rounded-full border border-emerald-400/30 bg-emerald-400/10">
                    <CheckIcon className="h-10 w-10 text-emerald-400" />
                  </div>

                  <h3 className="mt-5 text-2xl font-bold text-white">
                    Request sent!
                  </h3>

                  <p className="mx-auto mt-2 max-w-xs text-sm leading-6 text-slate-400">
                    Your message request has been sent to{" "}
                    <span className="font-semibold text-white">
                      {requestSentTo.username}
                    </span>
                    . Once they accept, you can start chatting.
                  </p>

                  <div className="mx-auto mt-6 flex max-w-xs items-center gap-3 rounded-2xl border border-slate-700 bg-slate-950 p-4 text-left">
                    <Avatar name={requestSentTo.username} size="h-12 w-12" />

                    <div className="min-w-0 flex-1">
                      <p className="truncate font-semibold text-white">
                        {requestSentTo.username}
                      </p>
                      <p className="font-mono text-xs text-slate-400">
                        {formatId(requestSentTo.public_id)}
                      </p>
                    </div>

                    <span className="shrink-0 rounded-full border border-amber-400/20 bg-amber-400/10 px-2.5 py-1 text-xs font-semibold text-amber-300">
                      Pending
                    </span>
                  </div>

                  <div className="mt-6 rounded-xl bg-slate-800/60 p-3 text-left">
                    <p className="text-sm font-medium text-slate-200">
                      What's next?
                    </p>
                    <p className="mt-1 text-xs leading-5 text-slate-400">
                      They'll find your request in their Message Requests panel.
                      You'll be able to chat once they accept it.
                    </p>
                  </div>

                  <button
                    onClick={closeSearch}
                    className="mt-6 w-full rounded-xl bg-teal-500 py-3 font-bold text-slate-950 transition hover:bg-teal-400"
                  >
                    Done
                  </button>
                </div>
              ) : (
                <>
                  {/* User ID input */}
                  <label
                    htmlFor="search-user-id"
                    className="mb-2 block text-sm font-semibold text-slate-300"
                  >
                    User ID
                  </label>

                  <input
                    id="search-user-id"
                    type="text"
                    value={searchId}
                    onChange={(event) => handleSearchChange(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") searchUser(searchId);
                    }}
                    placeholder="Enter their 8-character ID"
                    autoFocus
                    autoCapitalize="characters"
                    autoComplete="off"
                    spellCheck={false}
                    className="w-full rounded-xl border border-slate-700 bg-slate-950 p-3.5 font-mono text-base uppercase tracking-widest outline-none transition placeholder:font-sans placeholder:normal-case placeholder:tracking-normal focus:border-teal-500 focus:ring-2 focus:ring-teal-500/20"
                  />

                  <p className="mt-2 text-xs text-slate-500">
                    Ask them for their ID. They can find it on their profile.
                  </p>

                  <div className="mt-5">
                    {searchStatus === "idle" && (
                      <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-4">
                        <p className="text-sm text-slate-400">
                          Enter the ID to find the person you want to connect
                          with.
                        </p>
                      </div>
                    )}

                    {searchStatus === "loading" && (
                      <div className="flex items-center gap-3 rounded-xl border border-slate-800 bg-slate-950 p-4">
                        <span className="h-5 w-5 animate-spin rounded-full border-2 border-slate-700 border-t-teal-400" />
                        <p className="text-sm text-slate-300">
                          Searching for user...
                        </p>
                      </div>
                    )}

                    {searchStatus === "notfound" && (
                      <div className="rounded-xl border border-red-400/20 bg-red-400/5 p-4">
                        <p className="font-semibold text-red-300">
                          User not found
                        </p>
                        <p className="mt-1 text-sm text-slate-400">
                          We couldn't find that ID. Double-check it and try
                          again.
                        </p>
                      </div>
                    )}

                    {(searchStatus === "error" ||
                      searchStatus === "sendError") && (
                      <div className="rounded-xl border border-red-400/20 bg-red-400/5 p-4">
                        <p className="font-semibold text-red-300">
                          {searchStatus === "sendError"
                            ? "Couldn't send request"
                            : "Something went wrong"}
                        </p>
                        <p className="mt-1 text-sm text-slate-400">
                          {searchStatus === "sendError"
                            ? "They may already have a pending request or an existing conversation. Please try again later."
                            : "Please try again."}
                        </p>
                      </div>
                    )}

                    {searchStatus === "found" && searchResult && (
                      <div className="rounded-2xl border border-teal-500/20 bg-slate-950 p-4">
                        <div className="mb-4 flex items-center gap-2">
                          <span className="flex h-5 w-5 items-center justify-center rounded-full bg-emerald-400/15 text-emerald-400">
                            <CheckIcon className="h-3.5 w-3.5" />
                          </span>
                          <span className="text-sm font-semibold text-emerald-300">
                            User found
                          </span>
                        </div>

                        <div className="flex items-center gap-3">
                          <Avatar
                            name={searchResult.user.username}
                            size="h-14 w-14"
                            text="text-lg"
                          />

                          <div className="min-w-0 flex-1">
                            <p className="truncate text-base font-bold text-white">
                              {searchResult.user.username}
                            </p>
                            <p className="mt-1 font-mono text-xs tracking-wider text-slate-400">
                              {formatId(searchResult.user.public_id)}
                            </p>
                          </div>

                          <span className="rounded-full bg-emerald-400/10 px-2.5 py-1 text-xs font-semibold text-emerald-300">
                            Found
                          </span>
                        </div>

                        {searchResult.isSelf ? (
                          <p className="mt-4 rounded-lg bg-slate-900 p-3 text-sm text-slate-400">
                            This is your own account. Search for someone else's
                            ID to connect.
                          </p>
                        ) : (
                          <>
                            <p className="mt-4 text-sm leading-5 text-slate-400">
                              Send a message request to connect. You'll be able
                              to chat after they accept.
                            </p>

                            <button
                              onClick={() =>
                                sendMessageRequest(searchResult.user.id)
                              }
                              disabled={sendingRequest}
                              className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl bg-teal-500 px-4 py-3 font-bold text-slate-950 transition hover:bg-teal-400 disabled:cursor-not-allowed disabled:opacity-60"
                            >
                              {sendingRequest ? (
                                <>
                                  <span className="h-4 w-4 animate-spin rounded-full border-2 border-slate-950/30 border-t-slate-950" />
                                  Sending request...
                                </>
                              ) : (
                                <>
                                  <PlusIcon />
                                  Send message request
                                </>
                              )}
                            </button>
                          </>
                        )}
                      </div>
                    )}
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ================= Calls ================= */}
      <CallOverlay
        call={callApi.call}
        localStream={callApi.localStream}
        remoteStream={callApi.remoteStream}
        notice={callApi.notice}
        onAccept={callApi.acceptCall}
        onDecline={callApi.declineCall}
        onHangUp={callApi.hangUp}
        onToggleMute={callApi.toggleMute}
        onToggleCamera={callApi.toggleCamera}
      />
    </div>
  );
}

export default Chat;
