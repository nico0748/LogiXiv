import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { applyInitialTheme } from "./components/shell/ThemeToggle.tsx";
import { PresenterApp } from "./components/slides/PresenterApp.tsx";
import { presentingPaper } from "./lib/presenter.ts";
import "./styles.css";

// 最初の描画の前に明暗を決め、ちらつきを防ぐ
applyInitialTheme();

// 「発表」で開いた窓（?present=<論文ID>）は、スライドと論文だけを映す
const present = presentingPaper(location.search);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {present ? <PresenterApp paperId={present} /> : <App />}
  </StrictMode>,
);
