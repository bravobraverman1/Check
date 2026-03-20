// App entry point
import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import "./index.css";
import { bootstrapEdgeAuth } from "@/lib/edgeAuth";

bootstrapEdgeAuth();

createRoot(document.getElementById("root")!).render(<App />);
