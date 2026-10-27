import React from "react";
import { createRoot } from "react-dom/client";
import "./estate.css";
import App from "./App.js";
createRoot(document.getElementById("root")!).render(<App />);
if ("serviceWorker" in navigator) { navigator.serviceWorker.register("/sw.js").catch(()=>{}); }
