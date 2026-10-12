import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { API_URL } from "../config";

function Signup() {
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState("");

  const navigate = useNavigate();

  const handleSignup = async () => {
    try {
      const response = await fetch(`${API_URL}/signup`, {
        method: "POST",

        headers: {
          "Content-Type": "application/json",
        },

        body: JSON.stringify({
          username,
          email,
          password,
        }),
      });

      const result = await response.json();

      setMessage(result.message);

      if (response.ok) {
        navigate("/");
      }
    } catch (error) {
      console.log("SIGNUP ERROR",error);
      setMessage("Something went wrong");
    }
  };
  

  return (
    <div className="min-h-screen bg-slate-950 flex items-center justify-center">
      <div className="w-full max-w-sm bg-slate-900 p-8 rounded-xl">

        <h1 className="text-3xl font-bold text-white mb-6">
          Create Account
        </h1>

        <input
          type="text"
          placeholder="Username"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          className="w-full p-3 mb-3 rounded bg-slate-800 text-white"
        />

        <input
          type="email"
          placeholder="Email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="w-full p-3 mb-3 rounded bg-slate-800 text-white"
        />

        <input
          type="password"
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="w-full p-3 mb-4 rounded bg-slate-800 text-white"
        />

        <button
          onClick={handleSignup}
          className="w-full bg-blue-600 text-white p-3 rounded font-semibold"
        >
          Sign Up
        </button>

        <p className="text-slate-400 mt-4">
          {message}
        </p>

      </div>
    </div>
  );
}

export default Signup;