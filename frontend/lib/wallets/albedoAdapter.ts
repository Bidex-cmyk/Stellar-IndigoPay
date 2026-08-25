import type { StellarWalletAdapter } from "./types";
import albedo from "@albedo-link/intent";

export const albedoAdapter: StellarWalletAdapter = {
  id: "albedo",
  name: "Albedo",
  description: "Albedo Wallet",
  installUrl: "https://albedo.link",
  async isInstalled(): Promise<boolean> {
    return true; // Albedo is a web wallet, always "installed"
  },
  async connect(): Promise<void> {
    await albedo.publicKey({});
  },
  async getPublicKey(): Promise<string> {
    const res = await albedo.publicKey({});
    return res.pubkey;
  },
  async signTransaction(
    xdr: string,
    opts: { networkPassphrase: string; network: "TESTNET" | "MAINNET" }
  ): Promise<string> {
    const res = await albedo.tx({
      xdr: xdr,
      network: opts.network === "TESTNET" ? "testnet" : "public"
    });
    return res.signed_envelope_xdr;
  },
};
