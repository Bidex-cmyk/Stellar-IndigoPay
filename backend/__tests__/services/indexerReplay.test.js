"use strict";

const fs = require("fs");
const path = require("path");
const pool = require("../../src/db/pool");
const { fixtureMetadataSchema } = require("../../src/schemas/sorobanEventSchema");
const { HANDLERS, extractEventType, extractTopics, extractValue } = require("../../src/services/sorobanEventService");
const { v4: uuid } = require("uuid");

const fixturePath = path.join(__dirname, "../fixtures/events/golden-events.json");

describe("Indexer Pipeline Replay Determinism", () => {
  let fixtureData;

  beforeAll(async () => {
    // 1. Load fixtures and validate them against the schema
    const rawData = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
    fixtureData = fixtureMetadataSchema.parse(rawData);
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    // Clear state before each run
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("DELETE FROM soroban_event_dlq");
      await client.query("DELETE FROM indexer_state");
      await client.query("DELETE FROM donations WHERE project_id = $1", ["PROJECT_ID_MOCK"]);
      await client.query("DELETE FROM projects WHERE id = $1", ["PROJECT_ID_MOCK"]);
      await client.query("DELETE FROM profiles WHERE public_key = $1", ["GBDONORAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABC"]);
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  });

  async function applyFixtureEvents(events) {
    for (const evt of events) {
      const eventType = extractEventType(evt);
      const topics = extractTopics(evt);
      const value = extractValue(evt);

      if (HANDLERS[eventType]) {
        // Need to ensure projects exist if it's a donated event, or else foreign key might fail.
        // The project ID is usually topics[2] for donated. Let's create it if missing for test isolation.
        if (eventType === "donated") {
          const projectId = topics[2];
          await pool.query(
            "INSERT INTO projects (id, title, creator_address, raised_xlm) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING",
            [projectId, "Test Project", "GCREATOR", 0]
          );
        }

        await HANDLERS[eventType](evt, topics, value);
      }
    }
  }

  async function getDatabaseState() {
    const donations = (await pool.query("SELECT * FROM donations ORDER BY id")).rows;
    const profiles = (await pool.query("SELECT * FROM profiles ORDER BY public_key")).rows;
    const projects = (await pool.query("SELECT * FROM projects ORDER BY id")).rows;
    const dlq = (await pool.query("SELECT * FROM soroban_event_dlq ORDER BY id")).rows;
    return { donations, profiles, projects, dlq };
  }

  it("should process the fixture sequence deterministically", async () => {
    // Apply first time
    await applyFixtureEvents(fixtureData.events);
    const state1 = await getDatabaseState();

    // Clear state
    await pool.query("DELETE FROM soroban_event_dlq");
    await pool.query("DELETE FROM indexer_state");
    await pool.query("DELETE FROM donations WHERE project_id = $1", ["PROJECT_ID_MOCK"]);
    await pool.query("DELETE FROM projects WHERE id = $1", ["PROJECT_ID_MOCK"]);
    await pool.query("DELETE FROM profiles WHERE public_key = $1", ["GBDONORAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABC"]);

    // Apply second time
    await applyFixtureEvents(fixtureData.events);
    const state2 = await getDatabaseState();

    // Assert byte-identical resulting states
    expect(state1).toEqual(state2);

    // Verify it processed correctly
    expect(state1.donations.length).toBeGreaterThan(0);
  });

  it("should detect drift if a fixture is mutated", async () => {
    await applyFixtureEvents(fixtureData.events);
    const state1 = await getDatabaseState();

    // Clear state
    await pool.query("DELETE FROM soroban_event_dlq");
    await pool.query("DELETE FROM indexer_state");
    await pool.query("DELETE FROM donations WHERE project_id = $1", ["PROJECT_ID_MOCK"]);
    await pool.query("DELETE FROM projects WHERE id = $1", ["PROJECT_ID_MOCK"]);
    await pool.query("DELETE FROM profiles WHERE public_key = $1", ["GBDONORAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABC"]);

    // Mutate fixture slightly
    const mutatedEvents = JSON.parse(JSON.stringify(fixtureData.events));
    if (mutatedEvents[0].value && Array.isArray(mutatedEvents[0].value)) {
      mutatedEvents[0].value[0] = 20000000; // mutate amount
    }

    await applyFixtureEvents(mutatedEvents);
    const state2 = await getDatabaseState();

    expect(state1).not.toEqual(state2);
  });
});
