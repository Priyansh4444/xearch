import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import { App } from "./App";
import { SearchErrorBoundary } from "./ErrorBoundary";
import "./serp.css";

declare const __CONVEX_URL__: string; // injected by vite.config.ts from .env.local

const convex = new ConvexReactClient(__CONVEX_URL__);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ConvexProvider client={convex}>
      <SearchErrorBoundary>
        <App />
      </SearchErrorBoundary>
    </ConvexProvider>
  </StrictMode>,
);
