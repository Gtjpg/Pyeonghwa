import { useEffect, useState, useRef } from "react";
import { io } from "socket.io-client";

function Chat() {
  const [conversations, setConversations] = useState([]);
  const [activeConversation, setActiveConversation] = useState(null);
  const [socket, setSocket] = useState(null);
  const [messages, setMessages] = useState([]);
  const [messageInput, setMessageInput] = useState("");
  const messagesEndRef = useRef(null);

  useEffect(() => {
    async function loadConversations() {
      try {
        const token = localStorage.getItem("token");

        const response = await fetch("http://localhost:3000/conversations", {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        });

        if (!response.ok) {
          throw new Error("Failed to load conversations");
        }

        const data = await response.json();
        setConversations(data);
      } catch (error) {
        console.error("Conversation loading error:", error);
      }
    }

    loadConversations();
  }, []);

  useEffect(() => {
    if (!socket || !activeConversation) {
      return;
    }

    const room = `conversation_${activeConversation.conversation_id}`;

    socket.emit("join_room", room);

    console.log("Joining room:", room);
  }, [socket, activeConversation]);

  useEffect(() => {
    if (!socket) return;

    function handleChatHistory(history) {
      setMessages(history);
    }

    socket.on("chat_history", handleChatHistory);

    return () => {
      socket.off("chat_history", handleChatHistory);
    };
  }, [socket]);

  useEffect(() => {
    const token = localStorage.getItem("token");

    if (!token) {
      console.error("No login token found.");
      return;
    }

    const newSocket = io("http://localhost:3000", {
      auth: {
        token: token,
      },
    });

    newSocket.on("connect", () => {
      console.log("Socket connected:", newSocket.id);
    });

    newSocket.on("connect_error", (error) => {
      console.error("Socket connection error:", error.message);
    });

    setSocket(newSocket);

    return () => {
      newSocket.disconnect();
    };
  }, []);

  useEffect(() => {
    if (!socket) return;

    function handleNewMessage(message) {
      setMessages((previousMessages) => [
        ...previousMessages,
        {
          id: `${Date.now()}-${Math.random()}`,
          username: message.username,
          content: message.message,
        },
      ]);
    }

    socket.on("chat_message", handleNewMessage);

    return () => {
      socket.off("chat_message", handleNewMessage);
    };
  }, [socket]);

  function sendMessage() {
    if (!socket || !activeConversation) return;

    const message = messageInput.trim();

    if (!message) return;

    const room = `conversation_${activeConversation.conversation_id}`;

    socket.emit("chat_message", {
      room,
      message,
      keepHistory: activeConversation.keep_history,
    });

    setMessageInput("");
  }

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({
      behavior: "smooth",
    });
  }, [messages, activeConversation]);

  return (
    <div className="min-h-screen bg-slate-950 text-white flex">
      {/* Sidebar */}
      <aside className="w-80 border-r border-slate-800 p-5">
        <h1 className="text-2xl font-bold mb-2">ChatWeb</h1>

        <p className="text-sm text-slate-400 mb-6">Private conversations</p>

        {/* User search */}
        <input
          type="text"
          placeholder="Search users..."
          className="w-full bg-slate-900 border border-slate-700 rounded-lg p-3 outline-none focus:border-blue-500"
        />

        {/* Conversations */}
        <h2 className="text-sm font-semibold text-slate-400 mt-8 mb-3">
          CONVERSATIONS
        </h2>

        {conversations.length === 0 ? (
          <p className="text-sm text-slate-500">No conversations yet.</p>
        ) : (
          conversations.map((conversation) => (
            <button
              key={conversation.conversation_id}
              onClick={() => setActiveConversation(conversation)}
              className={`w-full text-left p-3 rounded-lg ${
                activeConversation?.conversation_id ===
                conversation.conversation_id
                  ? "bg-blue-600"
                  : "hover:bg-slate-800"
              }`}
            >
              {conversation.username}
            </button>
          ))
        )}
      </aside>

      {/* Main chat panel */}
      <main className="flex-1 flex flex-col min-h-0 h-screen overflow-hidden">
        {/* Chat header */}
        <header className="p-5 border-b border-slate-800">
          <div>
            
          </div>
          <h2 className="font-semibold">
            {activeConversation
              ? `Chatting with ${activeConversation.username}`
              : ""}
          </h2>
          {/* <p className="text-sm text-slate-400">
            {activeConversation
              ? "Your private conversation"
              : "Choose someone to start chatting."}
          </p> */}
        </header>

        {/* Message area */}

        <section className="flex-1 min-h-0 overflow-y-auto p-6 space-y-3">
          {!activeConversation ? (
            <div className="h-full flex items-center justify-center text-center">
              <p className="text-slate-400">
                Select a conversation to view messages.
              </p>
            </div>
          ) : messages.length === 0 ? (
            <div className="h-full flex items-center justify-center text-center">
              <p className="text-slate-400">
                No saved messages in this conversation yet.
              </p>
            </div>
          ) : (
            messages.map((msg) => (
              <div
                key={msg.id}
                className={`flex ${
                  msg.username ===
                  JSON.parse(localStorage.getItem("user"))?.username
                    ? "justify-end"
                    : "justify-start"
                }`}
              >
                <div
                  className={`max-w-[70%] rounded-2xl px-4 py-2 wrap-break-words ${
                    msg.username ===
                    JSON.parse(localStorage.getItem("user"))?.username
                      ? "bg-blue-600 text-white rounded-br-sm"
                      : "bg-slate-800 text-slate-100 rounded-bl-sm"
                  }`}
                >
                  <p className="text-xs opacity-70 mb-1">{msg.username}</p>
                  <p>{msg.content ?? msg.message}</p>
                </div>
              </div>
            ))
          )}
          <div ref={messagesEndRef} />
        </section>

        {/* Message input */}
        <footer className="shrink-0 p-4 border-t border-slate-800 bg-slate-950">
          <div className="flex gap-3">
            <input
              type="text"
              placeholder="Write a message..."
              value={messageInput}
              onChange={(e) => setMessageInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") sendMessage();
              }}
              disabled={!activeConversation}
              className="flex-1 bg-slate-900 border border-slate-800 rounded-lg p-3 disabled:opacity-50"
            />

            <button
              onClick={sendMessage}
              disabled={!activeConversation || !messageInput.trim()}
              className="bg-blue-600 px-5 rounded-lg font-semibold disabled:opacity-50"
            >
              Send
            </button>
          </div>
        </footer>
      </main>
    </div>
  );
}

export default Chat;
