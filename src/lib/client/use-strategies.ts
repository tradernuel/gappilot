"use client";

import { useCallback, useEffect, useState } from "react";
import { SavedStrategySchema, type SavedStrategy, type Strategy } from "../strategy/schema";

const KEY = "gappilot:strategies:v1";
const MAX_SAVED = 20;

/**
 * Saved strategies live in this browser only. Every load re-validates each
 * entry against the schema, so an edited or outdated entry is dropped rather
 * than trusted. Saving a strategy executes nothing.
 */
export function useStrategies() {
  const [saved, setSaved] = useState<SavedStrategy[]>([]);
  const [dropped, setDropped] = useState(0);

  useEffect(() => {
    try {
      const raw = JSON.parse(localStorage.getItem(KEY) ?? "[]") as unknown[];
      const valid = (Array.isArray(raw) ? raw : []).map((r) => SavedStrategySchema.safeParse(r)).filter((r) => r.success).map((r) => r.data!);
      setSaved(valid);
      setDropped((Array.isArray(raw) ? raw.length : 0) - valid.length);
    } catch {
      setSaved([]);
    }
  }, []);

  const persist = (next: SavedStrategy[]) => {
    setSaved(next);
    try {
      localStorage.setItem(KEY, JSON.stringify(next));
    } catch {
      /* storage unavailable: keep in memory */
    }
  };

  const save = useCallback(
    (strategy: Strategy, name: string): SavedStrategy | null => {
      const entry = SavedStrategySchema.safeParse({ id: crypto.randomUUID(), name, createdAt: Date.now(), strategy });
      if (!entry.success) return null;
      persist([entry.data, ...saved].slice(0, MAX_SAVED));
      return entry.data;
    },
    [saved],
  );

  const remove = useCallback((id: string) => persist(saved.filter((s) => s.id !== id)), [saved]);

  return { saved, save, remove, dropped };
}
