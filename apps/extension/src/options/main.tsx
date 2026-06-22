import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import Options from "./Options.js";

const container = document.getElementById("root");
if (!container) {
  throw new Error("Options root element #root not found");
}

createRoot(container).render(
  <StrictMode>
    <Options />
  </StrictMode>,
);
