import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Builds only the assistant-ui chat widget into public/chat/chat.js (a self-contained IIFE the plain HTML app loads).
export default defineConfig({
  plugins: [react()],
  publicDir: false,
  define: { "process.env.NODE_ENV": '"production"' },
  build: {
    outDir: "public/chat",
    emptyOutDir: true,
    lib: { entry: "web/src/chat.tsx", name: "BadgerChatBundle", formats: ["iife"], fileName: () => "chat.js" },
    chunkSizeWarningLimit: 2000,
  },
});
