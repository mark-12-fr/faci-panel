"use client";
// Shared alert popup + hook. Mirrors the per-page `showAlert(...)` used across
// the legacy pages. Signature: showAlert(title, message, color?, iconClass?).

import { useCallback, useState } from "react";

interface AlertState {
  show: boolean;
  title: string;
  message: string;
  icon: string;
  color: string;
}

const INITIAL: AlertState = {
  show: false,
  title: "",
  message: "",
  icon: "fa-circle-xmark",
  color: "#ef4444",
};

export function useAlert() {
  const [state, setState] = useState<AlertState>(INITIAL);

  const showAlert = useCallback(
    (title: string, message: string, color = "#ef4444", icon = "fa-circle-xmark") => {
      setState({ show: true, title, message, color, icon });
    },
    []
  );

  const closeAlert = useCallback(() => setState((s) => ({ ...s, show: false })), []);

  const alert = (
    <div
      className={`custom-alert-overlay${state.show ? " show" : ""}`}
      onClick={(e) => {
        if (e.target === e.currentTarget) closeAlert();
      }}
    >
      <div className="custom-alert-box">
        <i className={`fa-solid ${state.icon} custom-alert-icon`} style={{ color: state.color }} />
        <h3 className="custom-alert-title">{state.title}</h3>
        <p className="custom-alert-msg">{state.message}</p>
        <button onClick={closeAlert} className="custom-alert-btn">
          Okay
        </button>
      </div>
    </div>
  );

  return { alert, showAlert, closeAlert };
}
