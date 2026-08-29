import { createRoot } from "react-dom/client";
import { loadUiSettings } from "@/platform/settings";
import { Options } from "@/ui/Options";

const container = document.getElementById("root");

if (!container) {
  throw new Error("options: #root is missing from index.html");
}

const start = await loadUiSettings();

createRoot(container).render(<Options start={start} />);
