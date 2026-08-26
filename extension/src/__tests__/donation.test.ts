import {
  isValidStellarDestination,
  submitDonationRequest,
  validateDonationRequest,
  validateQuickDonateState,
} from "../lib/donation";

const VALID_DESTINATION =
  "GDFJEGWQOEPLIRVHKVNGCFQBZQNBDWUYOSRYLKKBOPFEBFHIYNDMKKHG";

beforeEach(() => {
  jest.clearAllMocks();
  (globalThis as any).chrome.runtime.lastError = null;
});

describe("donation validation", () => {
  test("accepts a valid Stellar destination and amount", () => {
    expect(isValidStellarDestination(VALID_DESTINATION)).toBe(true);
    expect(validateDonationRequest(VALID_DESTINATION, 5, "Thanks")).toBeNull();
  });

  test("rejects missing/invalid required state", () => {
    expect(validateDonationRequest("", 5)).toBe("Invalid destination address");
    expect(validateDonationRequest(VALID_DESTINATION, 0.05)).toBe(
      "Minimum donation is 0.1 XLM",
    );
  });

  test("rejects an oversized memo", () => {
    expect(validateDonationRequest(VALID_DESTINATION, 5, "A".repeat(29))).toBe(
      "Memo must be 28 characters or fewer",
    );
  });
});

describe("Quick Donate state validation", () => {
  test("requires a ready wallet, destination, and valid amount", () => {
    expect(validateQuickDonateState(null, VALID_DESTINATION, 5)).toBe(
      "Connect your wallet before donating.",
    );
    expect(validateQuickDonateState(VALID_DESTINATION, "", 5)).toBe(
      "Invalid destination address",
    );
    expect(validateQuickDonateState(VALID_DESTINATION, VALID_DESTINATION, 0.05)).toBe(
      "Minimum donation is 0.1 XLM",
    );
    expect(validateQuickDonateState(VALID_DESTINATION, VALID_DESTINATION, 5)).toBeNull();
  });
});

describe("submitDonationRequest", () => {
  test("uses the canonical SUBMIT_DONATION message", async () => {
    (chrome.runtime.sendMessage as jest.Mock).mockImplementation(
      (_message: unknown, callback: (response: { success: boolean }) => void) => {
        callback({ success: true });
      },
    );

    await expect(submitDonationRequest(VALID_DESTINATION, 5, "Thanks")).resolves.toBeUndefined();
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
      {
        type: "SUBMIT_DONATION",
        address: VALID_DESTINATION,
        amount: 5,
        memo: "Thanks",
      },
      expect.any(Function),
    );
  });

  test("does not send when required validation fails", async () => {
    await expect(submitDonationRequest("bad", 5)).rejects.toThrow(
      "Invalid destination address",
    );
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
  });
});
