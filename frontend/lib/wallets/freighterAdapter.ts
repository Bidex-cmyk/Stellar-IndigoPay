import type { StellarWalletAdapter } from "./types";
import { isConnected, requestAccess, signTransaction } from "@stellar/freighter-api";

export const freighterAdapter: StellarWalletAdapter = {
  id: "freighter",
  name: "Freighter",
  description: "Freighter Wallet",
  installUrl: "https://freighter.app",
  async isInstalled(): Promise<boolean> {
    return await isConnected();
  },
  async connect(): Promise<void> {
    await requestAccess();
  },
  async getPublicKey(): Promise<string> {
    const pubKey = await requestAccess();
    if (!pubKey) throw new Error("Could not get public key from Freighter");
    return pubKey;
  },
  async signTransaction(xdr: string, opts: any): Promise<string> {
    const signed = await signTransaction(xdr, { network: opts.network });
    return signed;
  },
};
