const token = localStorage.getItem("token");

const socket = io({
  auth: {
    token: token,
  },
});

socket.on("connect", () => {
  console.log("Socket connected:", socket.id);
});

socket.on("connect_error", (error) => {
  console.log("Socket connection error:", error.message);
});

const user = JSON.parse(localStorage.getItem("user"));

if (!user) {
  window.location.href = "/login.html";
}

const messageInput = document.getElementById("message");
const sendButton = document.getElementById("send");
const keepHistoryCheckbox = document.getElementById("keep-history");

const userSearchInput = document.getElementById("user-search");
const searchUserButton = document.getElementById("search-user");
const searchResults = document.getElementById("search-results");

const output = document.getElementById("output");

const conversationList = document.getElementById("conversation-list");

const chatWith = document.getElementById("chat-with");

const logoutButton = document.getElementById("logout");

let currentRoom = null;

console.log("Current user:", user);

// -------------------------
// SEND MESSAGE
// -------------------------

sendButton.addEventListener("click", () => {
  if (!currentRoom) {
    alert("Select a user first");
    return;
  }

  const message = messageInput.value.trim();

  if (!message) {
    return;
  }

  const data = {
    room: currentRoom,
    username: user.username,
    message: message,
    keepHistory: keepHistoryCheckbox.checked,
  };

  console.log("Sending:", data);

  socket.emit("chat_message", data);

  messageInput.value = "";
});

// -------------------------
// RECEIVE LIVE MESSAGE
// -------------------------

socket.on("chat_message", (data) => {
  const paragraph = document.createElement("p");

  const username = document.createElement("strong");
  username.textContent = `${data.username}: `;

  const message = document.createTextNode(data.message);

  paragraph.appendChild(username);
  paragraph.appendChild(message);

  output.appendChild(paragraph);
});

// -------------------------
// LOAD OLD CHAT HISTORY
// -------------------------

socket.on("chat_history", (messages) => {
  output.textContent = "";

  messages.forEach((msg) => {
    const paragraph = document.createElement("p");

    const username = document.createElement("strong");
    username.textContent = `${msg.username}: `;

    const message = document.createTextNode(msg.content);

    paragraph.appendChild(username);
    paragraph.appendChild(message);

    output.appendChild(paragraph);
  });
});

// -------------------------
// SEARCH USERS
// -------------------------

searchUserButton.addEventListener("click", async () => {
  const username = userSearchInput.value.trim();

  if (!username) {
    return;
  }

  try {
    const response = await fetch(
      `/users/search?username=${encodeURIComponent(username)}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      },
    );

    const users = await response.json();

    searchResults.textContent = "";

    users.forEach((foundUser) => {
      // Don't show yourself
      if (foundUser.id === user.id) {
        return;
      }

      const button = document.createElement("button");

      button.textContent = foundUser.username;

      // -------------------------
      // CLICK USER
      // -------------------------

      button.addEventListener("click", async () => {
        try {
          const response = await fetch("/conversations", {
            method: "POST",

            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${token}`,
            },

            body: JSON.stringify({
              targetUserId: foundUser.id,
            }),
          });

          const result = await response.json();

          if (!response.ok) {
            console.log(result.message);
            return;
          }

          // Example:
          // conversation_3

          chatWith.textContent = `Chatting with: ${foundUser.username}`;

          currentRoom = result.room;

          console.log("Joined:", currentRoom);

          // Clear previous conversation
          output.textContent = "";

          // Join Socket.IO room
          socket.emit("join_room", currentRoom);

          await loadConversations();
        } catch (error) {
          console.log("Conversation error:", error);
        }
      });

      searchResults.appendChild(button);
    });
  } catch (error) {
    console.log("Search error:", error);
  }
});

async function loadConversations() {
  try {
    const response = await fetch("/conversations", {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    const conversations = await response.json();

    conversationList.textContent = "";

    conversations.forEach((conversation) => {
      const button = document.createElement("button");

      button.textContent = conversation.username;

      button.addEventListener("click", () => {
        currentRoom = `conversation_${conversation.conversation_id}`;

        chatWith.textContent = `Chatting with: ${conversation.username}`;

        output.textContent = "";

        socket.emit("join_room", currentRoom);

        console.log("Joined:", currentRoom);
      });

      conversationList.appendChild(button);
    });

  } catch (error) {
    console.log("Failed to load conversations:", error);
  }
}

loadConversations();  

logoutButton.addEventListener("click", () => {
  localStorage.removeItem("token");
  localStorage.removeItem("user");

  socket.disconnect();

  window.location.href = "/login.html";
});