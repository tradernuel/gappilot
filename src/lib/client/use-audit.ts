"use client";

import { createContext, useCallback, useContext, useEffect, useState } from "react";
import type { AuditRecord } from "../execution/types";

const KEY = "gappilot:audit:v1";
const MAX = 200;

/**
 * Browser copy of audit records returned by the server (web demo). The
 * authoritative, hash-chained log for live runs is the local agent's JSONL file.
 */
export function useAuditStore() {
  const [records, setRecords] = useState<AuditRecord[]>([]);
  useEffect(() => {
    try {
      const raw = JSON.parse(localStorage.getItem(KEY) ?? "[]");
      if (Array.isArray(raw)) setRecords(raw.filter((r) => r && typeof r.id === "string" && typeof r.hash === "string"));
    } catch {
      /* ignore */
    }
  }, []);
  const add = useCallback((incoming: AuditRecord[]) => {
    setRecords((prev) => {
      const next = [...incoming.filter((r) => !prev.some((p) => p.id === r.id)).reverse(), ...prev].slice(0, MAX);
      try {
        localStorage.setItem(KEY, JSON.stringify(next));
      } catch {
        /* ignore */
      }
      return next;
    });
  }, []);
  const clear = useCallback(() => {
    setRecords([]);
    try {
      localStorage.removeItem(KEY);
    } catch {
      /* ignore */
    }
  }, []);
  return { records, add, clear };
}

export type AuditStore = ReturnType<typeof useAuditStore>;
export const AuditContext = createContext<AuditStore | null>(null);
export const useAudit = () => useContext(AuditContext);
