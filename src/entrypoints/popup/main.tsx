import { createRoot } from "react-dom/client";
import { App, loadPopup } from "@/ui/App";
import "./style.css";

const container = document.getElementById("root");

if (!container) {
  throw new Error("popup: #root is missing from index.html");
}

const start = await loadPopup();

createRoot(container).render(<App start={start} />);
