import { ReactNode } from "react";
import { Headphones } from "lucide-react";
import { Link } from "wouter";
import { PlayerBar } from "@/components/player-bar";

export function Layout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen flex flex-col relative overflow-hidden">
      {/* Subtle ambient background glow */}
      <div className="ambient-glow top-[calc(-10%-240px)] left-[calc(-10%-240px)]" />
      <div className="ambient-glow bottom-[calc(-10%-240px)] right-[calc(-10%-240px)]" />

      <header className="sticky top-0 z-50 w-full border-b border-white/10 bg-background/60 backdrop-blur-xl">
        <div className="max-w-5xl mx-auto flex h-16 items-center px-6">
          <Link
            href="/"
            className="flex items-center gap-2 group hover:opacity-80 transition-opacity"
          >
            <div className="w-8 h-8 rounded-xl bg-primary text-primary-foreground flex items-center justify-center shadow-md">
              <Headphones className="w-4 h-4" />
            </div>
            <span className="font-display font-bold text-lg tracking-tight text-foreground">
              Sonic<span className="text-muted-foreground font-medium">Extract</span>
            </span>
          </Link>
        </div>
      </header>

      <main className="flex-1 w-full max-w-5xl mx-auto px-6 py-12 flex flex-col gap-16 relative z-10">
        {children}
      </main>

      <footer className="w-full border-t border-border/40 py-8 mt-auto">
        <div className="max-w-5xl mx-auto px-6 text-center text-sm text-muted-foreground">
          <p>Designed for pure utility. Extracts audio in highest available quality.</p>
        </div>
      </footer>

      <PlayerBar />
    </div>
  );
}
