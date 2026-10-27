import { ShieldCheck } from "lucide-react";
import type { SaveSettings, YouTubeSignIn } from "@shared/schema";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";

type YouTubeSignInSettingProps = {
  /** The settings, or undefined while they load. */
  settings?: SaveSettings;
  onChange: (signIn: YouTubeSignIn) => void;
};

/**
 * "Use my Firefox YouTube sign-in": off by default. When YouTube asks the app
 * to "confirm you're not a bot", the app asks again at once, signed in with
 * Firefox's YouTube cookies (server/youtube-limits.ts). Only on the computer
 * running the app: another device can't change what the app signs in with.
 */
export function YouTubeSignInSetting({ settings, onChange }: YouTubeSignInSettingProps) {
  if (!settings?.canSaveToFolder) return null;
  const on = settings.youtubeSignIn === "firefox";
  return (
    <div className="mx-auto flex max-w-lg items-start gap-3 text-left">
      <ShieldCheck className="w-4 h-4 mt-0.5 shrink-0 text-muted-foreground" />
      <div className="flex-1">
        <Label
          htmlFor="youtube-sign-in"
          className="text-sm font-medium text-foreground cursor-pointer"
        >
          Use my Firefox YouTube sign-in
        </Label>
        <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
          Only when YouTube asks to confirm you're not a bot. Sign in to YouTube in Firefox first; a
          spare Google account is safest, since YouTube can flag accounts used by download apps.
        </p>
      </div>
      <Switch
        id="youtube-sign-in"
        checked={on}
        onCheckedChange={(checked) => onChange(checked ? "firefox" : "off")}
        className="mt-0.5"
      />
    </div>
  );
}
