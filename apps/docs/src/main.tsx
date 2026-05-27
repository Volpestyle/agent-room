import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { DocsApp } from "@volpestyle/agent-docs";
import "@volpestyle/agent-docs/styles.css";

import docsConfig from "./content";

createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <DocsApp config={docsConfig} />
  </StrictMode>,
);
