/** DEMO ONLY. Entry point for the hosted test app (single-file build). */
import "./install";
import { createRoot } from "react-dom/client";
import { Dashboard } from "../components/dashboard/Dashboard";
import { DemoBar } from "./DemoBar";

createRoot(document.getElementById("root")!).render(
  <>
    <Dashboard />
    <DemoBar />
  </>,
);
