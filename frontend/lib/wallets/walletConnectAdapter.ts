import type { StellarWalletAdapter } from "./types";

const projectId = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID || "33df051012ab6ce7e155bc2973f08f1b"; // Default mock projectId if undefined

let provider: any = null;
let modal: any = null;
let currentSession: any = null;

async function getProvider() {
  if (!provider) {
    const UniversalProvider = (await import("@walletconnect/universal-provider")).default;
    provider = await UniversalProvider.init({
      projectId,
      metadata: {
        name: "IndigoPay",
        description: "Stellar Payments",
        url: typeof window !== "undefined" ? window.location.origin : "https://indigopay.example.com",
        icons: []
      }
    });
  }
  return provider;
}

export const walletConnectAdapter: StellarWalletAdapter = {
  id: "walletConnect",
  name: "WalletConnect",
  description: "WalletConnect",
  installUrl: "https://walletconnect.com/",
  
  async isInstalled(): Promise<boolean> {
    return true;
  },
  
  async connect(): Promise<void> {
    const prov = await getProvider();
    
    if (!modal) {
      const { WalletConnectModal } = await import("@walletconnect/modal");
      modal = new WalletConnectModal({ projectId });
    }

    if (!currentSession) {
      prov.on("display_uri", (uri: string) => {
        modal?.openModal({ uri });
      });

      currentSession = await prov.connect({
        namespaces: {
          stellar: {
            methods: ["stellar_signXDR"],
            chains: ["stellar:pubnet"], // or testnet depending on opts
            events: []
          }
        }
      });
      
      modal.closeModal();
    }
  },
  
  async getPublicKey(): Promise<string> {
    const prov = await getProvider();
    // Reconnect if session already exists
    if (!currentSession && prov.session) {
        currentSession = prov.session;
    }
    
    if (!currentSession) {
      await this.connect();
    }
    
    const accounts = currentSession.namespaces.stellar.accounts;
    const address = accounts[0].split(":")[2];
    return address;
  },
  
  async signTransaction(xdr: string, opts: any): Promise<string> {
    const prov = await getProvider();
    if (!currentSession) {
        throw new Error("Not connected");
    }
    
    const accounts = currentSession.namespaces.stellar.accounts;
    
    const result = await prov.request({
      method: "stellar_signXDR",
      params: {
        xdr
      }
    }, "stellar:pubnet");
    
    // Result is usually the signed XDR or object containing it
    return (result as any).signedXDR || (result as any).xdr || (result as any);
  }
};
