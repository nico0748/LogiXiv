import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { applyInitialTheme } from "./components/shell/ThemeToggle.tsx";
import "./styles.css";

// 最初の描画の前に明暗を決め、ちらつきを防ぐ
applyInitialTheme();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
