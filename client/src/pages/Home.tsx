import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useToast } from "@/hooks/use-toast";
import { Layout } from "@/components/layout";
import { useVideoInfo, useRecentDownloads } from "@/hooks/use-youtube";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "@shared/routes";
import { formatDistanceToNow } from "date-fns";
import {
  Search,
  ArrowRight,
  Music,
  Loader2,
  Download,
  AlertCircle,
  FileAudio,
  History,
} from "lucide-react";

export default function Home() {
  const [url, setUrl] = useState("");
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { mutate: fetchInfo, isPending, data: videoInfo, error, reset } = useVideoInfo();
  const { data: recentDownloads, isLoading: isLoadingHistory } = useRecentDownloads();

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!url.trim()) return;

    // Basic optimistic validation
    try {
      new URL(url);
    } catch {
      toast({
        title: "Invalid URL",
        description: "Please enter a valid YouTube URL.",
        variant: "destructive",
      });
      return;
    }

    fetchInfo(url, {
      onError: (err) => {
        toast({
          title: "Couldn't fetch video",
          description: err.message,
          variant: "destructive",
        });
      },
    });
  };

  const handleDownload = () => {
    if (!videoInfo) return;

    toast({
      title: "Download Started",
      description: "Your audio file is being prepared.",
    });

    // Invalidate history after a brief delay assuming the download successfully registered
    setTimeout(() => {
      queryClient.invalidateQueries({ queryKey: [api.downloads.list.path] });
    }, 2000);
  };

  return (
    <Layout>
      {/* Hero Section */}
      <section className="flex flex-col items-center text-center space-y-6 max-w-2xl mx-auto pt-8">
        <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-secondary text-secondary-foreground text-sm font-medium border border-border">
          <span className="flex h-2 w-2 rounded-full bg-primary animate-pulse" />
          High Quality Audio Extraction
        </div>

        <h1 className="text-4xl md:text-6xl font-display font-extrabold tracking-tight text-foreground leading-[1.1]">
          Convert any YouTube video to{" "}
          <span className="text-transparent bg-clip-text bg-gradient-to-r from-primary/80 to-primary">
            pure audio.
          </span>
        </h1>

        <p className="text-lg text-muted-foreground leading-relaxed max-w-xl">
          Paste a link below to instantly extract crisp, high-quality audio tracks from your
          favorite videos, podcasts, and lectures.
        </p>

        {/* Input Form */}
        <form onSubmit={handleSubmit} className="w-full relative mt-8 group">
          <div className="absolute inset-0 bg-primary/5 blur-2xl rounded-3xl transition-opacity duration-500 opacity-0 group-hover:opacity-100" />
          <div className="relative flex items-center w-full bg-card rounded-2xl shadow-lg shadow-black/5 border border-border focus-within:ring-4 focus-within:ring-primary/10 transition-all duration-300 p-2">
            <Search className="w-6 h-6 text-muted-foreground ml-4 mr-2" />
            <input
              type="url"
              placeholder="https://www.youtube.com/watch?v=..."
              className="flex-1 bg-transparent border-none text-foreground placeholder:text-muted-foreground h-14 px-2 text-lg focus:outline-none"
              value={url}
              onChange={(e) => {
                setUrl(e.target.value);
                if (error) reset();
              }}
              required
            />
            <button
              type="submit"
              disabled={isPending || !url}
              className="h-14 px-6 md:px-8 rounded-xl bg-primary text-primary-foreground font-semibold flex items-center gap-2 hover-elevate disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:-translate-y-0 transition-all"
            >
              {isPending ? (
                <>
                  <Loader2 className="w-5 h-5 animate-spin" />
                  <span className="hidden sm:inline">Processing...</span>
                </>
              ) : (
                <>
                  <span className="hidden sm:inline">Extract</span>
                  <ArrowRight className="w-5 h-5" />
                </>
              )}
            </button>
          </div>
        </form>
      </section>

      {/* Result Section */}
      <AnimatePresence mode="wait">
        {videoInfo && (
          <motion.section
            initial={{ opacity: 0, y: 20, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -20, scale: 0.98 }}
            transition={{ duration: 0.4, ease: [0.23, 1, 0.32, 1] }}
            className="w-full max-w-3xl mx-auto"
          >
            <div className="glass-card rounded-[2rem] p-4 md:p-6 flex flex-col md:flex-row gap-6 items-center">
              {/* Thumbnail */}
              <div className="w-full md:w-1/2 aspect-video relative rounded-2xl overflow-hidden shadow-md group">
                <img
                  src={videoInfo.thumbnail}
                  alt={videoInfo.title}
                  className="w-full h-full object-cover transition-transform duration-700 group-hover:scale-105"
                />
                <div className="absolute inset-0 bg-gradient-to-t from-black/60 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-300" />
                <div className="absolute bottom-3 left-3 bg-black/70 backdrop-blur-md text-white text-xs font-semibold px-2.5 py-1 rounded-md flex items-center gap-1.5">
                  <Music className="w-3 h-3" /> Audio Track
                </div>
              </div>

              {/* Info & Action */}
              <div className="flex-1 flex flex-col items-center text-center md:items-start md:text-left gap-4 w-full">
                <h3 className="font-display font-bold text-xl md:text-2xl line-clamp-3 text-foreground">
                  {videoInfo.title}
                </h3>

                <p className="text-sm text-muted-foreground line-clamp-1">
                  Ready to download as a 320 kbps MP3.
                </p>

                <div className="mt-2 w-full">
                  <a
                    href={`/api/video/download?url=${encodeURIComponent(videoInfo.url)}`}
                    download
                    onClick={handleDownload}
                    className="w-full flex items-center justify-center gap-2 h-14 rounded-xl bg-foreground text-background font-semibold hover-elevate active-elevate-2 transition-all shadow-xl shadow-foreground/20"
                  >
                    <Download className="w-5 h-5" />
                    Download Audio
                  </a>
                  <button
                    onClick={() => {
                      reset();
                      setUrl("");
                    }}
                    className="w-full mt-3 text-sm text-muted-foreground hover:text-foreground transition-colors font-medium"
                  >
                    Clear and start over
                  </button>
                </div>
              </div>
            </div>
          </motion.section>
        )}

        {error && (
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            className="max-w-2xl mx-auto w-full"
          >
            <div className="bg-destructive/10 text-destructive-foreground border border-destructive/20 rounded-2xl p-4 flex items-center gap-3">
              <AlertCircle className="w-5 h-5 text-destructive" />
              <p className="text-sm font-medium text-destructive">{error.message}</p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Recent History */}
      <section className="mt-12 max-w-4xl mx-auto w-full space-y-6">
        <div className="flex items-center gap-2 px-2">
          <History className="w-5 h-5 text-muted-foreground" />
          <h2 className="text-xl font-display font-semibold">Recent Extractions</h2>
        </div>

        {isLoadingHistory ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {[1, 2, 3].map((i) => (
              <div
                key={i}
                className="h-24 bg-secondary/50 rounded-2xl animate-pulse border border-border/50"
              />
            ))}
          </div>
        ) : recentDownloads && recentDownloads.length > 0 ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {recentDownloads.map((item) => (
              <div
                key={item.id}
                className="group p-4 rounded-2xl border border-border bg-card hover:shadow-lg hover:shadow-black/5 transition-all duration-300 flex flex-col justify-between h-full hover:border-primary/20"
              >
                <div className="space-y-3">
                  <div className="w-10 h-10 rounded-xl bg-primary/5 flex items-center justify-center text-primary group-hover:scale-110 transition-transform duration-300">
                    <FileAudio className="w-5 h-5" />
                  </div>
                  <h4 className="font-medium text-foreground text-sm line-clamp-2 leading-tight">
                    {item.title}
                  </h4>
                </div>

                <div className="pt-4 mt-4 border-t border-border/50 flex items-center justify-between text-xs text-muted-foreground">
                  <span>
                    {item.downloadedAt
                      ? formatDistanceToNow(new Date(item.downloadedAt), { addSuffix: true })
                      : "Recently"}
                  </span>
                  <a
                    href={`/api/video/download?url=${encodeURIComponent(item.url)}`}
                    download
                    className="text-primary font-medium hover:underline flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity"
                  >
                    Redownload <Download className="w-3 h-3" />
                  </a>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="text-center py-16 px-4 rounded-3xl border border-dashed border-border/60 bg-secondary/20 flex flex-col items-center">
            <div className="w-12 h-12 rounded-full bg-secondary flex items-center justify-center mb-4">
              <FileAudio className="w-6 h-6 text-muted-foreground" />
            </div>
            <h3 className="text-lg font-medium text-foreground">No downloads yet</h3>
            <p className="text-sm text-muted-foreground mt-1 max-w-sm">
              Your recent audio extractions will appear here for quick access later.
            </p>
          </div>
        )}
      </section>
    </Layout>
  );
}
