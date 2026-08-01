import { create } from "zustand";
import type { OrganizationGraph, User } from "../types";

export type Appearance = "system" | "dark" | "light";

interface SessionState {
  me: User | null;
  githubLogin: string | null;
  repository: string | null;
  users: User[];
  organization: OrganizationGraph;
  appearance: Appearance;
  loading: boolean;
  signedIn: boolean;
  /** VAPID key from the relay; null when Web Push isn't configured there. */
  vapidPublicKey: string | null;
  setSession: (input: {
    me: User | null;
    githubLogin: string | null;
    repository: string | null;
    users: User[];
    organization: OrganizationGraph;
    vapidPublicKey?: string | null;
  }) => void;
  setMe: (me: User) => void;
  setOrganization: (users: User[], organization: OrganizationGraph) => void;
  setAppearance: (appearance: Appearance) => void;
  setLoading: (loading: boolean) => void;
  signOut: () => void;
}

const APPEARANCE_KEY = "ttfw.appearance";

function storedAppearance(): Appearance {
  if (typeof localStorage === "undefined") return "system";
  const value = localStorage.getItem(APPEARANCE_KEY);
  return value === "dark" || value === "light" ? value : "system";
}

/** Reflects the appearance choice onto <html data-theme>, like preferredColorScheme on iOS. */
export function applyAppearance(appearance: Appearance) {
  if (typeof document === "undefined") return;
  const resolved =
    appearance === "system"
      ? window.matchMedia("(prefers-color-scheme: light)").matches
        ? "light"
        : "dark"
      : appearance;
  document.documentElement.dataset.theme = resolved;
}

export const useSessionStore = create<SessionState>((set) => ({
  me: null,
  githubLogin: null,
  repository: null,
  users: [],
  organization: { nodes: [], edges: [] },
  appearance: storedAppearance(),
  loading: true,
  signedIn: false,
  vapidPublicKey: null,

  setSession: ({ me, githubLogin, repository, users, organization, vapidPublicKey }) =>
    set({
      me,
      githubLogin,
      repository,
      users,
      organization,
      vapidPublicKey: vapidPublicKey ?? null,
      signedIn: true,
      loading: false,
    }),

  setMe: (me) => set({ me }),

  setOrganization: (users, organization) => set({ users, organization }),

  setAppearance: (appearance) => {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(APPEARANCE_KEY, appearance);
    }
    applyAppearance(appearance);
    set({ appearance });
  },

  setLoading: (loading) => set({ loading }),

  signOut: () =>
    set({ me: null, githubLogin: null, repository: null, signedIn: false, loading: false }),
}));
