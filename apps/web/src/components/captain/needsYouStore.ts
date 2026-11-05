import { create } from "zustand";

interface NeedsYouState {
  readonly open: boolean;
  readonly setOpen: (open: boolean) => void;
}

export const useNeedsYouStore = create<NeedsYouState>((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
}));

export const openNeedsYou = () => useNeedsYouStore.getState().setOpen(true);
