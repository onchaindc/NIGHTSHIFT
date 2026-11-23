"use client";

import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const STORAGE_KEY = "nightshift-inapp-wallet";

export interface InAppWallet {
  address: `0x${string}`;
  privateKey: `0x${string}`;
}

function load(): InAppWallet | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { privateKey?: string };
    if (!parsed.privateKey || !parsed.privateKey.startsWith("0x")) return null;
    const account = privateKeyToAccount(parsed.privateKey as `0x${string}`);
    return { address: account.address, privateKey: parsed.privateKey as `0x${string}` };
  } catch {
    return null;
  }
}

export function getOrCreateWallet(): InAppWallet {
  const existing = load();
  if (existing) return existing;
  const privateKey = generatePrivateKey();
  const account = privateKeyToAccount(privateKey);
  const wallet: InAppWallet = { address: account.address, privateKey };
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ privateKey }));
  return wallet;
}

export function getWallet(): InAppWallet | null {
  return load();
}

export function clearWallet(): void {
  if (typeof window === "undefined") return;
  localStorage.removeItem(STORAGE_KEY);
}
