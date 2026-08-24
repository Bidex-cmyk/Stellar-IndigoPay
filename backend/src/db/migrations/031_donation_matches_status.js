/**
 * 031_donation_matches_status
 *
 * The donation-matching feature shipped with a `status` lifecycle
 * (active → expired | exhausted | cancelled) in schema.sql, but the
 * migration path never added the column. `recordDonation` (routes/
 * donations.js) filters active offers with `WHERE status = 'active'` and
 * matchExpiry.js flips pools between statuses, so on a migration-built
 * database every XLM donation failed with `column "status" does not exist`.
 *
 * This migration closes the gap so the migration-built schema matches
 * schema.sql exactly.
 */

module.exports = {
  name: "031_donation_matches_status",

  async up(client) {
    await client.query(`
      ALTER TABLE donation_matches ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active';
    `);
    await client.query(`
      ALTER TABLE donation_matches DROP CONSTRAINT IF EXISTS donation_matches_status_check;
    `);
    await client.query(`
      ALTER TABLE donation_matches ADD CONSTRAINT donation_matches_status_check
        CHECK (status IN ('active', 'expired', 'exhausted', 'cancelled'));
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_donation_matches_status
        ON donation_matches (status, project_id);
    `);
  },

  async down(client) {
    await client.query("DROP INDEX IF EXISTS idx_donation_matches_status;");
    await client.query("ALTER TABLE donation_matches DROP CONSTRAINT IF EXISTS donation_matches_status_check;");
    await client.query("ALTER TABLE donation_matches DROP COLUMN IF EXISTS status;");
  },
};
