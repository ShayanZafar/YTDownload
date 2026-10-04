import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "client", "src"),
      "@shared": path.resolve(import.meta.dirname, "shared"),
      "@assets": path.resolve(import.meta.dirname, "attached_assets"),
    },
  },
  root: path.resolve(import.meta.dirname, "client"),
  build: {
    outDir: path.resolve(import.meta.dirname, "dist/public"),
    emptyOutDir: true,
  },
  // The development server (npm run dev; server/vite.ts applies these options).
  server: {
    // Vite sends files by their path on disk (/@fs/<path>) to anyone who can reach
    // the app — with HOST=0.0.0.0, every device on the network. So it sends only
    // what the page loads: its code (client/), shared/, and packages (node_modules,
    // with Vite's pre-bundled ones in node_modules/.vite) — never data/ (the history
    // and settings), the server's code or anything else in the project.
    fs: {
      strict: true,
      allow: [
        path.resolve(import.meta.dirname, "client"),
        path.resolve(import.meta.dirname, "shared"),
        path.resolve(import.meta.dirname, "node_modules"),
      ],
      deny: [
        // Vite's own list, which this one replaces…
        ".env",
        ".env.*",
        "*.{crt,pem,key,p12,pfx,cer,der}",
        ".npmrc",
        ".yarnrc.yml",
        "**/.git/**",
        // …and every other dotfile, in any folder.
        "**/.*",
      ],
    },
  },
});
