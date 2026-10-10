const usernameInput = document.getElementById("username");
const passwordInput = document.getElementById("password");
const loginButton = document.getElementById("login");
const message = document.getElementById("message");

loginButton.addEventListener("click", async () => {
  const data = {
    username: usernameInput.value,
    password: passwordInput.value,
  };

  try {
    const response = await fetch("/login", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(data),
    });

    const result = await response.json();

    message.textContent = result.message;

    
    if (response.ok) {
      localStorage.setItem("token", result.token);
      localStorage.setItem("user", JSON.stringify(result.user));

      window.location.href = "/";
    }

  } catch (error) {
    console.log(error);
    message.textContent = "Something went wrong";
  }
});