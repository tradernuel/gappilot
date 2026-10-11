"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * Minimal EIP-1193 wallet connection. Reads the account and chain ONLY.
 * GapPilot never asks the wallet to sign or send anything in this version.
 */

interface Eip1193Provider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
  on?(event: string, handler: (...args: unknown[]) => void): void;
  removeListener?(event: string, handler: (...args: unknown[]) => void): void;
}

declare global {
  interface Window {
    ethereum?: Eip1193Provider;
  }
}

export const BSC_CHAIN_ID_HEX = "0x38";

export type WalletState =
  | { status: "unavailable" }
  | { status: "disconnected"; error?: string }
  | { status: "connecting" }
  | { status: "connected"; address: string; chainId: string; onBsc: boolean };

const STORAGE_KEY = "gappilot:wallet-connected";

function remember(on: boolean) {
  try {
    if (on) localStorage.setItem(STORAGE_KEY, "1");
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* storage unavailable */
  }
}

export function useWallet() {
  const [state, setState] = useState<WalletState>({ status: "disconnected" });

  const read = useCallback(async (provider: Eip1193Provider, method: "eth_accounts" | "eth_requestAccounts") => {
    const accounts = (await provider.request({ method })) as string[];
    const chainId = String(await provider.request({ method: "eth_chainId" })).toLowerCase();
    const address = accounts[0];
    if (!address) {
      setState({ status: "disconnected" });
      return;
    }
    setState({ status: "connected", address, chainId, onBsc: chainId === BSC_CHAIN_ID_HEX });
    remember(true);
  }, []);

  useEffect(() => {
    const provider = window.ethereum;
    if (!provider) {
      setState({ status: "unavailable" });
      return;
    }
    let wanted = false;
    try {
      wanted = localStorage.getItem(STORAGE_KEY) === "1";
    } catch {
      /* ignore */
    }
    if (wanted) read(provider, "eth_accounts").catch(() => setState({ status: "disconnected" }));

    const onChange = () => {
      read(provider, "eth_accounts").catch(() => setState({ status: "disconnected" }));
    };
    provider.on?.("accountsChanged", onChange);
    provider.on?.("chainChanged", onChange);
    return () => {
      provider.removeListener?.("accountsChanged", onChange);
      provider.removeListener?.("chainChanged", onChange);
    };
  }, [read]);

  const connect = useCallback(async () => {
    const provider = window.ethereum;
    if (!provider) return setState({ status: "unavailable" });
    setState({ status: "connecting" });
    try {
      await read(provider, "eth_requestAccounts");
    } catch (e) {
      const code = (e as { code?: number }).code;
      setState({ status: "disconnected", error: code === 4001 ? "Connection request was rejected in the wallet." : "The wallet did not connect." });
    }
  }, [read]);

  /** Forgets the wallet in GapPilot. (EIP-1193 has no standard way to revoke the site's access.) */
  const disconnect = useCallback(() => {
    remember(false);
    setState({ status: "disconnected" });
  }, []);

  const switchToBsc = useCallback(async () => {
    try {
      await window.ethereum?.request({ method: "wallet_switchEthereumChain", params: [{ chainId: BSC_CHAIN_ID_HEX }] });
    } catch {
      /* user declined or wallet lacks BSC; chainChanged keeps state accurate */
    }
  }, []);

  return { state, connect, disconnect, switchToBsc };
}
