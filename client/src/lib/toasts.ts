import { useEffect, useState } from "react";

export interface Toast {
  id: number;
  text: string;
  kind: "info" | "warning";
  // Optional action button (e.g. "Activar micrófono" on a host request).
  actionLabel?: string;
  onAction?: () => void;
}

type Listener = (toasts: Toast[]) => void;

let toasts: Toast[] = [];
let nextId = 1;
const listeners = new Set<Listener>();

function emit(): void {
  for (const l of listeners) l(toasts);
}

export function showToast(input: Omit<Toast, "id">, durationMs = 6000): void {
  const toast: Toast = { id: nextId++, ...input };
  toasts = [...toasts.slice(-3), toast]; // keep at most 4 on screen
  emit();
  setTimeout(() => dismissToast(toast.id), durationMs);
}

export function dismissToast(id: number): void {
  if (!toasts.some((t) => t.id === id)) return;
  toasts = toasts.filter((t) => t.id !== id);
  emit();
}

// Module-level store instead of a context: toasts get fired from socket
// handlers (outside React) and rendered by whichever page mounts the
// viewport -- no provider plumbing needed.
export function useToasts(): Toast[] {
  const [list, setList] = useState<Toast[]>(toasts);
  useEffect(() => {
    listeners.add(setList);
    return () => {
      listeners.delete(setList);
    };
  }, []);
  return list;
}
