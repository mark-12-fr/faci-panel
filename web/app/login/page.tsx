"use client";

import { useEffect, useRef, useState } from "react";
import { apiPost } from "@/lib/api";
import { ApiError } from "@/lib/api";
import { getItem, isLoggedIn, removeItem, saveSession, setItem } from "@/lib/session";
import { useAlert } from "@/components/CustomAlert";
import "./login.css";

type BtnState = "idle" | "verifying" | "success";

export default function LoginPage() {
  const { alert, showAlert } = useAlert();

  const [accountId, setAccountId] = useState("");
  const [password, setPassword] = useState("");
  const [rememberMe, setRememberMe] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  const [splashHidden, setSplashHidden] = useState(false);
  const [splashSubtitle, setSplashSubtitle] = useState("MJR Vertex");
  const [splashLoading, setSplashLoading] = useState(true);
  const [btnState, setBtnState] = useState<BtnState>("idle");
  const redirectingRef = useRef(false);

  // Auto-login / remember-me + splash timing (mirrors the legacy DOMContentLoaded).
  useEffect(() => {
    if (isLoggedIn()) {
      setSplashLoading(false);
      setSplashSubtitle("Loading your workspace...");
      redirectingRef.current = true;
      const t = setTimeout(() => {
        window.location.href = "/";
      }, 800);
      return () => clearTimeout(t);
    }
    const remembered = getItem("remembered_faci_id");
    if (remembered) {
      setAccountId(remembered);
      setRememberMe(true);
    }
    const t = setTimeout(() => setSplashHidden(true), 1800);
    return () => clearTimeout(t);
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const id = accountId.trim();
    const pw = password.trim();
    setBtnState("verifying");

    try {
      const result = await apiPost<{ token: string; faci: any }>(
        "/api/faci/login",
        { account_id: id, password: pw },
        { auth: false }
      );

      if (rememberMe) setItem("remembered_faci_id", id);
      else removeItem("remembered_faci_id");

      saveSession(result.faci, result.token);

      setBtnState("success");
      setTimeout(() => {
        window.location.href = "/";
      }, 800);
    } catch (error) {
      if (error instanceof ApiError && (error.status === 401 || error.status === 400)) {
        showAlert(
          "Login Failed",
          "We couldn't find an account with those details. Please check your ID and password.",
          "#ef4444",
          "fa-circle-xmark"
        );
      } else {
        showAlert(
          "Connection Error",
          "We're having trouble connecting. Please check your internet connection and try again.",
          "#f59e0b",
          "fa-wifi"
        );
      }
      setBtnState("idle");
    }
  }

  return (
    <div className="login-page">
      <div className={`splash-screen${splashHidden ? " hide" : ""}`}>
        <div className="splash-content">
          <div className="splash-logo-container">
            <img src="/logo.jpg" alt="Logo" />
          </div>
          <h1 className="splash-title">AcadTrack</h1>
          <p className="splash-subtitle">{splashSubtitle}</p>
          {splashLoading && <div className="splash-loader" />}
        </div>
      </div>

      <div className="login-container">
        <div className="login-header">
          <h2>Welcome Facilitator</h2>
          <p>Login to your account</p>
        </div>

        <form onSubmit={handleSubmit}>
          <div className="input-group">
            <label htmlFor="accountId">Facilitator ID</label>
            <input
              type="text"
              id="accountId"
              placeholder="e.g. FACI-1234"
              required
              value={accountId}
              onChange={(e) => setAccountId(e.target.value)}
            />
          </div>

          <div className="input-group">
            <label htmlFor="password">Password</label>
            <div className="password-wrapper">
              <input
                type={showPassword ? "text" : "password"}
                id="password"
                placeholder="Enter your password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
              <i
                className={`fa-solid ${showPassword ? "fa-eye-slash" : "fa-eye"} toggle-password`}
                title="Show/Hide Password"
                onClick={() => setShowPassword((v) => !v)}
              />
            </div>
          </div>

          <div className="options-row">
            <label className="remember-me">
              <input
                type="checkbox"
                checked={rememberMe}
                onChange={(e) => setRememberMe(e.target.checked)}
              />{" "}
              Remember me
            </label>
          </div>

          <button
            type="submit"
            className="login-btn"
            id="loginBtn"
            disabled={btnState !== "idle"}
            style={btnState === "success" ? { backgroundColor: "#10b981" } : undefined}
          >
            {btnState === "verifying" && (
              <>
                <i className="fa-solid fa-circle-notch fa-spin" /> Verifying...
              </>
            )}
            {btnState === "success" && (
              <>
                <i className="fa-solid fa-check" /> Login successful
              </>
            )}
            {btnState === "idle" && "Login"}
          </button>
        </form>
      </div>

      {alert}
    </div>
  );
}
