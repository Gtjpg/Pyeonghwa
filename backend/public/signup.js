const usernameInput = document.getElementById("username");
const emailInput = document.getElementById("email");
const passwordInput = document.getElementById("password");
const signupButton = document.getElementById("signup");
const message = document.getElementById("message");

signupButton.addEventListener("click", async () => {
  const data = {
    username: usernameInput.value,
    email: emailInput.value,
    password: passwordInput.value,
  };

  try {
    const response = await fetch("/signup", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(data),
    });

    const result = await response.json();

    message.textContent = result.message;
  } catch (error) {
    console.log(error);
    message.textContent = "Something went wrong";
  }
});