/**
 * lib/__tests__/WalletProvider.test.tsx
 *
 * Unit tests for the centralised wallet React context
 * (`lib/WalletProvider.tsx`). Wallet adapters are mocked so we
 * exercise the provider's state machine — not real browser extensions.
 */
import React from "react";
import { render, screen, act, waitFor } from "@testing-library/react";

const ADMIN = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const DONOR = "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

/** In-memory mock of the wallet adapter layer. */
const mockAdapter = {
  id: "freighter" as const,
  name: "Freighter",
  description: "Mock wallet",
  installUrl: "https://freighter.app",
  isInstalled: jest.fn().mockResolvedValue(true),
  getPublicKey: jest.fn().mockResolvedValue(DONOR),
  signTransaction: jest.fn().mockResolvedValue("SIGNED_XDR"),
};

const mockResolveDefaultWallet = jest.fn();
const mockGetWalletById = jest.fn();
const mockPersistWalletSelection = jest.fn();
const mockClearWalletSelection = jest.fn();

jest.mock("@/lib/wallets", () => ({
  getAvailableWallets: jest.fn().mockResolvedValue([mockAdapter]),
  getWalletById: (...args: unknown[]) => mockGetWalletById(...args),
  resolveDefaultWallet: (...args: unknown[]) => mockResolveDefaultWallet(...args),
  persistWalletSelection: (...args: unknown[]) => mockPersistWalletSelection(...args),
  clearWalletSelection: (...args: unknown[]) => mockClearWalletSelection(...args),
}));

import { WalletProvider, useWallet } from "@/lib/WalletProvider";

/**
 * Consumer that surfaces every relevant context value as data-testids.
 */
function Dump() {
  const w = useWallet();
  return (
    <div>
      <span data-testid="state">{w.state}</span>
      <span data-testid="wallet-id">{w.walletId ?? ""}</span>
      <span data-testid="public-key">{w.publicKey ?? ""}</span>
      <span data-testid="installed">{String(w.isInstalled)}</span>
      <span data-testid="connected">{String(w.isConnected)}</span>
      <span data-testid="connecting">{String(w.isConnecting)}</span>
      <span data-testid="error">{w.error ?? ""}</span>
      <button data-testid="connect" onClick={() => void w.connect()}>
        connect
      </button>
      <button data-testid="disconnect" onClick={w.disconnect}>
        disconnect
      </button>
      <span data-testid="admin-result">{String(w.isAdmin(ADMIN))}</span>
    </div>
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  mockAdapter.isInstalled.mockResolvedValue(true);
  mockAdapter.getPublicKey.mockResolvedValue(DONOR);
  mockAdapter.signTransaction.mockResolvedValue("SIGNED_XDR");
  mockResolveDefaultWallet.mockResolvedValue({ adapter: mockAdapter, id: "freighter" });
  mockGetWalletById.mockImplementation((id: string) => (id === "freighter" ? mockAdapter : undefined));
});

describe("WalletProvider", () => {
  it("restores a previously authorised public key on mount", async () => {
    render(
      <WalletProvider>
        <Dump />
      </WalletProvider>,
    );

    await waitFor(() =>
      expect(screen.getByTestId("state").textContent).toBe("connected"),
    );
    expect(screen.getByTestId("public-key").textContent).toBe(DONOR);
    expect(screen.getByTestId("installed").textContent).toBe("true");
    expect(screen.getByTestId("connected").textContent).toBe("true");
    expect(screen.getByTestId("wallet-id").textContent).toBe("freighter");
  });

  it("stays idle when no wallet is installed", async () => {
    mockResolveDefaultWallet.mockResolvedValue(null);

    render(
      <WalletProvider>
        <Dump />
      </WalletProvider>,
    );

    await waitFor(() =>
      expect(screen.getByTestId("state").textContent).toBe("idle"),
    );
    expect(screen.getByTestId("installed").textContent).toBe("false");
    expect(screen.getByTestId("public-key").textContent).toBe("");
  });

  it("connect() transitions to connected after user grants access", async () => {
    // On mount, resolveDefaultWallet returns null so we start idle
    mockResolveDefaultWallet.mockResolvedValue(null);

    render(
      <WalletProvider>
        <Dump />
      </WalletProvider>,
    );
    await waitFor(() =>
      expect(screen.getByTestId("state").textContent).toBe("idle"),
    );

    // Now make resolveDefaultWallet return a valid adapter for connect()
    mockResolveDefaultWallet.mockResolvedValue({ adapter: mockAdapter, id: "freighter" });

    await act(async () => {
      screen.getByTestId("connect").click();
    });

    await waitFor(() =>
      expect(screen.getByTestId("state").textContent).toBe("connected"),
    );
    expect(screen.getByTestId("public-key").textContent).toBe(DONOR);
    expect(screen.getByTestId("error").textContent).toBe("");
    expect(mockAdapter.getPublicKey).toHaveBeenCalledTimes(1);
    expect(mockPersistWalletSelection).toHaveBeenCalledWith("freighter");
  });

  it("moves to error state when connect() is rejected by user", async () => {
    mockResolveDefaultWallet.mockResolvedValue(null);

    render(
      <WalletProvider>
        <Dump />
      </WalletProvider>,
    );
    await waitFor(() =>
      expect(screen.getByTestId("state").textContent).toBe("idle"),
    );

    mockResolveDefaultWallet.mockResolvedValue({ adapter: mockAdapter, id: "freighter" });
    mockAdapter.getPublicKey.mockRejectedValueOnce(new Error("user rejected access"));

    await act(async () => {
      screen.getByTestId("connect").click();
    });

    await waitFor(() =>
      expect(screen.getByTestId("state").textContent).toBe("error"),
    );
    expect(screen.getByTestId("error").textContent).toMatch(/rejected access/i);
  });

  it("handles connection rejection gracefully", async () => {
    mockResolveDefaultWallet.mockResolvedValue(null);

    render(
      <WalletProvider>
        <Dump />
      </WalletProvider>,
    );
    await waitFor(() =>
      expect(screen.getByTestId("state").textContent).toBe("idle"),
    );

    mockResolveDefaultWallet.mockResolvedValue({ adapter: mockAdapter, id: "freighter" });
    mockAdapter.getPublicKey.mockRejectedValueOnce(new Error("User declined"));

    await act(async () => {
      screen.getByTestId("connect").click();
    });

    await waitFor(() =>
      expect(screen.getByTestId("state").textContent).toBe("error"),
    );
    expect(screen.getByTestId("error").textContent).toMatch(/rejected/i);
  });

  it("disconnect() clears the public key, wallet id, and state", async () => {
    render(
      <WalletProvider>
        <Dump />
      </WalletProvider>,
    );
    await waitFor(() =>
      expect(screen.getByTestId("state").textContent).toBe("connected"),
    );

    act(() => {
      screen.getByTestId("disconnect").click();
    });

    expect(screen.getByTestId("state").textContent).toBe("idle");
    expect(screen.getByTestId("public-key").textContent).toBe("");
    expect(screen.getByTestId("wallet-id").textContent).toBe("");
    expect(screen.getByTestId("connected").textContent).toBe("false");
    expect(mockClearWalletSelection).toHaveBeenCalledTimes(1);
  });

  it("isAdmin returns true only when the connected key matches", async () => {
    mockAdapter.getPublicKey.mockResolvedValue(ADMIN.toLowerCase());

    render(
      <WalletProvider>
        <Dump />
      </WalletProvider>,
    );
    await waitFor(() =>
      expect(screen.getByTestId("state").textContent).toBe("connected"),
    );

    expect(screen.getByTestId("admin-result").textContent).toBe("true");
  });

  it("isAdmin returns false when key does not match", async () => {
    mockAdapter.getPublicKey.mockResolvedValue(DONOR);

    render(
      <WalletProvider>
        <Dump />
      </WalletProvider>,
    );
    await waitFor(() =>
      expect(screen.getByTestId("state").textContent).toBe("connected"),
    );

    expect(screen.getByTestId("admin-result").textContent).toBe("false");
  });

  it("isAdmin handles null / empty arguments without throwing", async () => {
    function ProbeEmpty() {
      const w = useWallet();
      return (
        <>
          <span data-testid="null-result">{String(w.isAdmin(null))}</span>
          <span data-testid="empty-result">{String(w.isAdmin(""))}</span>
        </>
      );
    }

    render(
      <WalletProvider>
        <ProbeEmpty />
      </WalletProvider>,
    );
    await waitFor(() =>
      expect(screen.getByTestId("null-result").textContent).toBe("false"),
    );
    expect(screen.getByTestId("empty-result").textContent).toBe("false");
  });

  it("sign() returns signedXDR when wallet is connected", async () => {
    render(
      <WalletProvider>
        <Dump />
      </WalletProvider>,
    );
    await waitFor(() =>
      expect(screen.getByTestId("state").textContent).toBe("connected"),
    );

    // Access the hook directly via a child component
    function SignProbe() {
      const w = useWallet();
      const [result, setResult] = React.useState<string>("");
      return (
        <>
          <button
            data-testid="do-sign"
            onClick={async () => {
              const r = await w.sign("UNSIGNED_XDR");
              setResult(r.signedXDR ?? r.error ?? "");
            }}
          >
            sign
          </button>
          <span data-testid="sign-result">{result}</span>
        </>
      );
    }

    render(
      <WalletProvider>
        <SignProbe />
      </WalletProvider>,
    );
    await waitFor(() =>
      expect(screen.getByTestId("do-sign")).toBeInTheDocument(),
    );

    await act(async () => {
      screen.getByTestId("do-sign").click();
    });

    await waitFor(() =>
      expect(screen.getByTestId("sign-result").textContent).toBe("SIGNED_XDR"),
    );
  });
});

describe("useWallet outside the provider", () => {
  it("returns a safe no-op fallback so older pages do not crash", () => {
    function Probe() {
      const w = useWallet();
      return (
        <>
          <span data-testid="state">{w.state}</span>
          <span data-testid="connected">{String(w.isConnected)}</span>
        </>
      );
    }

    render(<Probe />);

    expect(screen.getByTestId("state").textContent).toBe("idle");
    expect(screen.getByTestId("connected").textContent).toBe("false");
  });
});
