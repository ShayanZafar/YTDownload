import { useMutation, useQuery } from "@tanstack/react-query";
import { api } from "@shared/routes";
import type { SpotifyAccount } from "@shared/schema";
import { queryClient } from "@/lib/queryClient";
import {
  fetchOwnPlaylists,
  fetchSpotifyAccount,
  saveClientId,
  signOutOfSpotify,
  startSpotifySignIn,
} from "@/lib/spotify-account";

const ACCOUNT_KEY = [api.spotifyAccount.status.path];
const PLAYLISTS_KEY = [api.spotifyAccount.playlists.path];

/**
 * Your Spotify sign-in: whether there's a Client ID, who is signed in, and
 * (signed in) your playlists. Signing in sends this tab to Spotify, which
 * sends it back to the app.
 */
export function useSpotifyAccount() {
  const account = useQuery({
    queryKey: ACCOUNT_KEY,
    queryFn: fetchSpotifyAccount,
    // Another tab may have signed in or out.
    refetchOnWindowFocus: true,
  });
  const signedIn = Boolean(account.data?.signedInAs);
  const playlists = useQuery({
    queryKey: PLAYLISTS_KEY,
    queryFn: fetchOwnPlaylists,
    enabled: signedIn,
    staleTime: 5 * 60_000,
  });
  const settled = (next: SpotifyAccount) => {
    queryClient.setQueryData(ACCOUNT_KEY, next);
    queryClient.removeQueries({ queryKey: PLAYLISTS_KEY });
  };
  const clientId = useMutation({ mutationFn: saveClientId, onSuccess: settled });
  const signOut = useMutation({ mutationFn: signOutOfSpotify, onSuccess: settled });
  const signIn = useMutation({
    mutationFn: startSpotifySignIn,
    onSuccess: (url) => window.location.assign(url),
  });
  return { account: account.data, playlists, clientId, signIn, signOut };
}
