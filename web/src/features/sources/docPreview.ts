import { create } from "zustand";
import type { CardSource } from "../../core/types";

interface DocPreviewState {
  source: CardSource | null;
  open: (source: CardSource) => void;
  close: () => void;
}

/**
 * One preview at a time, opened from anywhere a source chip lives — the feed
 * card, the context column, a digest. Kept in a store rather than threaded
 * through props so no screen has to know the others exist.
 */
export const useDocPreview = create<DocPreviewState>((set) => ({
  source: null,
  open: (source) => set({ source }),
  close: () => set({ source: null }),
}));

/** A connected document is readable in-app; anything else is just a link. */
export const isReadableDoc = (source: CardSource) => source.kind === "doc";
