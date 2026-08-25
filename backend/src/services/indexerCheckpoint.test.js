const crypto = require("crypto");
global.crypto = crypto;
global.File = class File {};

jest.mock("../db/pool", () => ({
  query: jest.fn(),
}));

jest.mock("./stellar", () => {
  return {
    server: {
      operations: jest.fn().mockReturnThis(),
      cursor: jest.fn().mockReturnThis(),
      stream: jest.fn().mockReturnValue(jest.fn()), // mock closer function
      ledgers: jest.fn().mockReturnThis(),
      order: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      call: jest.fn().mockResolvedValue({ records: [{ sequence: 12345 }] })
    }
  };
});

const pool = require("../db/pool");
const { startIndexer, stop } = require("./indexerService");
const { start: startSoroban, stop: stopSoroban } = require("./sorobanEventService");

describe("Checkpoint Corruption Detection", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    pool.query.mockResolvedValue({ rows: [] }); // default mock
  });

  afterAll(async () => {
    await stop();
    stopSoroban();
  });

  test("indexerService throws on invalid hash", async () => {
    // For checkLag
    pool.query.mockResolvedValueOnce({ rows: [{ sequence: 12345 }] }); // not actually used by checkLag directly like this, but checkLag uses pool
    
    // We override pool.query just for readCursor which is called during openStream (and maybe checkLag)
    pool.query.mockImplementation((queryStr) => {
      if (queryStr.includes("SELECT last_processed_ledger")) {
        return Promise.resolve({
          rows: [{ last_processed_ledger: 12345, cursor_hash: 'invalidhash' }]
        });
      }
      return Promise.resolve({ rows: [] });
    });
    
    await expect(startIndexer()).rejects.toThrow(/Checkpoint corruption detected/);
  });

  test("sorobanEventService throws on invalid hash", async () => {
    pool.query.mockImplementation((queryStr) => {
      if (queryStr.includes("SELECT value")) {
        return Promise.resolve({
          rows: [{ value: '12345', cursor_hash: 'invalidhash' }]
        });
      }
      return Promise.resolve({ rows: [] });
    });
    
    await expect(startSoroban()).rejects.toThrow(/Checkpoint corruption detected/);
  });
  
  test("services start normally with valid hash", async () => {
    pool.query.mockImplementation((queryStr) => {
      if (queryStr.includes("SELECT last_processed_ledger")) {
        const primaryHash = crypto.createHash("sha256").update("12345").digest("hex");
        return Promise.resolve({
          rows: [{ last_processed_ledger: 12345, cursor_hash: primaryHash }]
        });
      }
      if (queryStr.includes("SELECT value")) {
        const sorobanHash = crypto.createHash("sha256").update("12345").digest("hex");
        return Promise.resolve({
          rows: [{ value: '12345', cursor_hash: sorobanHash }]
        });
      }
      return Promise.resolve({ rows: [] });
    });

    // Should not throw
    await expect(startIndexer()).resolves.toBeUndefined();
    await expect(startSoroban()).resolves.toBeUndefined();
  });
});
