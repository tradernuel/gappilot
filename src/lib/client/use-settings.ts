"use client";

import { useCallback, useEffect, useState } from "react";
import { DEFAULT_USER_RULES, UserRulesSchema, type UserRules } from "../agent/types";

export interface Settings {
  /** Trade size evaluated per opportunity, in stablecoin units (≈ USD). */
  notional: number;
  maxPairs: number;
  /** 0 = off. */
  refreshSec: 0 | 30 | 60;
  /** The agent's rules. They can only make recommendations stricter than the engine. */
  rules: UserRules;
}

export const DEFAULT_SETTINGS: Settings = { notional: 100, maxPairs: 10, refreshSec: 0, rules: DEFAULT_USER_RULES };
const KEY = "gappilot:settings:v1";

function sanitize(v: Partial<Settings>): Settings {
  const notional = Number(v.notional);
  const maxPairs = Number(v.maxPairs);
  return {
    notional: Number.isFinite(notional) && notional > 0 && notional <= 1_000_000 ? notional : DEFAULT_SETTINGS.notional,
    maxPairs: Number.isInteger(maxPairs) && maxPairs >= 1 && maxPairs <= 25 ? maxPairs : DEFAULT_SETTINGS.maxPairs,
    refreshSec: v.refreshSec === 30 || v.refreshSec === 60 ? v.refreshSec : 0,
    rules: UserRulesSchema.safeParse(v.rules).success ? (v.rules as UserRules) : DEFAULT_USER_RULES,
  };
}

export function useSettings() {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) setSettings(sanitize(JSON.parse(raw)));
    } catch {
      /* ignore bad or unavailable storage */
    }
    setLoaded(true);
  }, []);

  const update = useCallback((next: Partial<Settings>) => {
    setSettings((prev) => {
      const merged = sanitize({ ...prev, ...next });
      try {
        localStorage.setItem(KEY, JSON.stringify(merged));
      } catch {
        /* ignore */
      }
      return merged;
    });
  }, []);

  return { settings, update, loaded };
}

export { sanitize as sanitizeSettings };
