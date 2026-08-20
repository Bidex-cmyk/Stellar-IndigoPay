#![no_std]
#![allow(deprecated)]

use soroban_sdk::{contract, contractimpl, contracttype, symbol_short, Address, Env};

const MAX_OBSERVATIONS: u32 = 20;
const TWAP_WINDOW: u32 = 10;
const STALENESS_THRESHOLD: u32 = 720;
const PRICE_SCALE: i128 = 10_000_000;

/// Maximum number of slash events retained per reporter.
/// Older entries are evicted in a ring-buffer fashion.
const MAX_SLASH_HISTORY: u32 = 20;

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct PriceObservation {
    pub price: i128,
    pub reporter: Address,
    pub recorded_at: u32,
}

/// A record of a single slash event against a reporter.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct SlashEvent {
    /// Ledger sequence at which the slash occurred.
    pub at: u32,
    /// Admin who performed the slash.
    pub slashed_by: Address,
    /// Reason string (max 32 bytes to stay within a single symbol).
    pub reason: soroban_sdk::Symbol,
}

/// Ring-buffer pointer for per-reporter slash history.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct SlashHistoryMeta {
    /// Index of the *next* write slot (wraps at MAX_SLASH_HISTORY).
    pub next_index: u32,
    /// Total events written so far (capped at MAX_SLASH_HISTORY once full).
    pub count: u32,
}

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Admin,
    Observations(u32),
    ObservationCount,
    ObservationIndex,
    Reporter(Address),
    FallbackPrice,
    /// Per-reporter slash-history ring-buffer metadata.
    SlashHistoryMeta(Address),
    /// Individual slash event stored at a ring-buffer slot.
    SlashEvent(Address, u32),
}

#[contract]
pub struct SimpleOracle;

fn require_admin(env: &Env, admin: &Address) {
    let stored_admin: Address = env
        .storage()
        .instance()
        .get(&DataKey::Admin)
        .expect("Oracle not initialized");
    if stored_admin != *admin {
        panic!("Only admin can perform this action");
    }
}

#[contractimpl]
impl SimpleOracle {
    pub fn initialize(env: Env, admin: Address) {
        if env.storage().instance().has(&DataKey::Admin) {
            panic!("Contract already initialized");
        }
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage()
            .instance()
            .set(&DataKey::ObservationCount, &0_u32);
        env.storage()
            .instance()
            .set(&DataKey::ObservationIndex, &0_u32);
    }

    pub fn add_reporter(env: Env, admin: Address, reporter: Address) {
        admin.require_auth();
        require_admin(&env, &admin);
        env.storage()
            .instance()
            .set(&DataKey::Reporter(reporter.clone()), &true);
        env.events()
            .publish((symbol_short!("rep_add"), admin), reporter);
    }

    pub fn remove_reporter(env: Env, admin: Address, reporter: Address) {
        admin.require_auth();
        require_admin(&env, &admin);
        env.storage()
            .instance()
            .remove(&DataKey::Reporter(reporter.clone()));
        env.events()
            .publish((symbol_short!("rep_rem"), admin), reporter);
    }

    pub fn report_price(env: Env, reporter: Address, price: i128) {
        reporter.require_auth();

        let is_reporter: bool = env
            .storage()
            .instance()
            .get(&DataKey::Reporter(reporter.clone()))
            .unwrap_or(false);
        if !is_reporter {
            panic!("Not an authorised reporter");
        }
        if price <= 0 {
            panic!("Price must be positive");
        }

        let count: u32 = env
            .storage()
            .instance()
            .get(&DataKey::ObservationCount)
            .unwrap_or(0);
        let index: u32 = env
            .storage()
            .instance()
            .get(&DataKey::ObservationIndex)
            .unwrap_or(0);
        let observation = PriceObservation {
            price,
            reporter: reporter.clone(),
            recorded_at: env.ledger().sequence(),
        };

        env.storage()
            .instance()
            .set(&DataKey::Observations(index), &observation);
        env.storage().instance().set(
            &DataKey::ObservationCount,
            &(count + 1).min(MAX_OBSERVATIONS),
        );
        env.storage().instance().set(
            &DataKey::ObservationIndex,
            &((index + 1) % MAX_OBSERVATIONS),
        );
        env.events().publish(
            (symbol_short!("price_upd"), reporter),
            (price, env.ledger().sequence()),
        );
    }

    pub fn set_fallback_price(env: Env, admin: Address, price: i128) {
        admin.require_auth();
        require_admin(&env, &admin);
        if price <= 0 {
            panic!("Fallback price must be positive");
        }
        env.storage()
            .instance()
            .set(&DataKey::FallbackPrice, &price);
    }

    pub fn get_price(env: Env) -> i128 {
        let count: u32 = env
            .storage()
            .instance()
            .get(&DataKey::ObservationCount)
            .unwrap_or(0);
        if count == 0 {
            return env
                .storage()
                .instance()
                .get(&DataKey::FallbackPrice)
                .expect("Oracle has no observations and no fallback");
        }

        let next_index: u32 = env
            .storage()
            .instance()
            .get(&DataKey::ObservationIndex)
            .unwrap_or(0);
        let latest_index = (next_index + MAX_OBSERVATIONS - 1) % MAX_OBSERVATIONS;
        let latest: PriceObservation = env
            .storage()
            .instance()
            .get(&DataKey::Observations(latest_index))
            .expect("Oracle observation missing");

        if env.ledger().sequence().saturating_sub(latest.recorded_at) > STALENESS_THRESHOLD {
            return env
                .storage()
                .instance()
                .get(&DataKey::FallbackPrice)
                .expect("Oracle price is stale and no fallback configured");
        }

        let window = TWAP_WINDOW.min(count);
        let mut sum = 0_i128;
        for offset in 0..window {
            let index = (next_index + MAX_OBSERVATIONS - 1 - offset) % MAX_OBSERVATIONS;
            let observation: PriceObservation = env
                .storage()
                .instance()
                .get(&DataKey::Observations(index))
                .expect("Oracle observation missing");
            sum = sum.checked_add(observation.price).expect("TWAP overflow");
        }

        sum / i128::from(window) / PRICE_SCALE
    }

    // ── Slash history ────────────────────────────────────────────────────

    /// Admin-only slash: records a bounded SlashEvent for the given reporter.
    /// History is capped at [`MAX_SLASH_HISTORY`] entries; oldest entries are
    /// evicted in ring-buffer order. Each slash also emits a `slash_ev` event
    /// so off-chain observers can still track the full history.
    pub fn slash_reporter(
        env: Env,
        admin: Address,
        reporter: Address,
        reason: soroban_sdk::Symbol,
    ) {
        admin.require_auth();
        require_admin(&env, &admin);

        let meta_key = DataKey::SlashHistoryMeta(reporter.clone());
        let mut meta: SlashHistoryMeta =
            env.storage()
                .instance()
                .get(&meta_key)
                .unwrap_or(SlashHistoryMeta {
                    next_index: 0,
                    count: 0,
                });

        let slot = meta.next_index;
        let event = SlashEvent {
            at: env.ledger().sequence(),
            slashed_by: admin.clone(),
            reason,
        };

        env.storage()
            .instance()
            .set(&DataKey::SlashEvent(reporter.clone(), slot), &event);

        meta.count = (meta.count + 1).min(MAX_SLASH_HISTORY);
        meta.next_index = (slot + 1) % MAX_SLASH_HISTORY;
        env.storage().instance().set(&meta_key, &meta);

        // Emit event so off-chain observers can track the full history
        env.events()
            .publish((symbol_short!("slash_ev"), reporter.clone()), event);
    }

    /// Returns the number of slash events currently stored for a reporter.
    /// This is capped at [`MAX_SLASH_HISTORY`].
    pub fn get_slash_count(env: Env, reporter: Address) -> u32 {
        let meta: SlashHistoryMeta = env
            .storage()
            .instance()
            .get(&DataKey::SlashHistoryMeta(reporter))
            .unwrap_or(SlashHistoryMeta {
                next_index: 0,
                count: 0,
            });
        meta.count
    }

    /// Returns the slash event stored at a specific ring-buffer slot index for
    /// a reporter. Panics if the slot has never been written.
    pub fn get_slash_event_at(env: Env, reporter: Address, index: u32) -> SlashEvent {
        assert!(index < MAX_SLASH_HISTORY, "Slash event index out of bounds");
        env.storage()
            .instance()
            .get(&DataKey::SlashEvent(reporter, index))
            .expect("Slash event slot is empty")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::{
        testutils::{Address as _, Ledger},
        Env,
    };

    fn setup() -> (Env, Address, Address, Address) {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(SimpleOracle, ());
        let admin = Address::generate(&env);
        let reporter = Address::generate(&env);
        SimpleOracleClient::new(&env, &contract_id).initialize(&admin);
        (env, contract_id, admin, reporter)
    }

    fn add_reporter(env: &Env, contract_id: &Address, admin: &Address, reporter: &Address) {
        SimpleOracleClient::new(env, contract_id).add_reporter(admin, reporter);
    }

    #[test]
    #[should_panic(expected = "Oracle has no observations and no fallback")]
    fn no_observations_without_fallback_panics() {
        let (env, contract_id, _, _) = setup();
        SimpleOracleClient::new(&env, &contract_id).get_price();
    }

    #[test]
    fn no_observations_uses_fallback() {
        let (env, contract_id, admin, _) = setup();
        let client = SimpleOracleClient::new(&env, &contract_id);
        client.set_fallback_price(&admin, &8);
        assert_eq!(client.get_price(), 8);
    }

    #[test]
    #[should_panic(expected = "Contract already initialized")]
    fn initialize_only_once() {
        let (env, contract_id, admin, _) = setup();
        SimpleOracleClient::new(&env, &contract_id).initialize(&admin);
    }

    #[test]
    fn one_observation_is_returned() {
        let (env, contract_id, admin, reporter) = setup();
        let client = SimpleOracleClient::new(&env, &contract_id);
        add_reporter(&env, &contract_id, &admin, &reporter);
        client.report_price(&reporter, &80_000_000);
        assert_eq!(client.get_price(), 8);
    }

    #[test]
    fn averages_fewer_than_ten_observations() {
        let (env, contract_id, admin, reporter) = setup();
        let client = SimpleOracleClient::new(&env, &contract_id);
        add_reporter(&env, &contract_id, &admin, &reporter);
        for price in [60_000_000_i128, 90_000_000, 120_000_000] {
            client.report_price(&reporter, &price);
        }
        assert_eq!(client.get_price(), 9);
    }

    #[test]
    fn averages_only_latest_ten_observations() {
        let (env, contract_id, admin, reporter) = setup();
        let client = SimpleOracleClient::new(&env, &contract_id);
        add_reporter(&env, &contract_id, &admin, &reporter);
        for price in 1_i128..=15 {
            client.report_price(&reporter, &(price * PRICE_SCALE));
        }
        assert_eq!(client.get_price(), 10);
    }

    #[test]
    fn multiple_reporters_contribute_to_twap() {
        let (env, contract_id, admin, reporter_one) = setup();
        let reporter_two = Address::generate(&env);
        let client = SimpleOracleClient::new(&env, &contract_id);
        add_reporter(&env, &contract_id, &admin, &reporter_one);
        add_reporter(&env, &contract_id, &admin, &reporter_two);
        client.report_price(&reporter_one, &80_000_000);
        client.report_price(&reporter_two, &120_000_000);
        assert_eq!(client.get_price(), 10);
    }

    #[test]
    #[should_panic(expected = "Not an authorised reporter")]
    fn non_reporter_cannot_report() {
        let (env, contract_id, _, reporter) = setup();
        SimpleOracleClient::new(&env, &contract_id).report_price(&reporter, &80_000_000);
    }

    #[test]
    #[should_panic(expected = "Not an authorised reporter")]
    fn removed_reporter_cannot_report() {
        let (env, contract_id, admin, reporter) = setup();
        let client = SimpleOracleClient::new(&env, &contract_id);
        add_reporter(&env, &contract_id, &admin, &reporter);
        client.remove_reporter(&admin, &reporter);
        client.report_price(&reporter, &80_000_000);
    }

    #[test]
    #[should_panic(expected = "Only admin can perform this action")]
    fn only_admin_can_add_reporter() {
        let (env, contract_id, _, reporter) = setup();
        let non_admin = Address::generate(&env);
        SimpleOracleClient::new(&env, &contract_id).add_reporter(&non_admin, &reporter);
    }

    #[test]
    #[should_panic(expected = "Only admin can perform this action")]
    fn only_admin_can_remove_reporter() {
        let (env, contract_id, admin, reporter) = setup();
        add_reporter(&env, &contract_id, &admin, &reporter);
        let non_admin = Address::generate(&env);
        SimpleOracleClient::new(&env, &contract_id).remove_reporter(&non_admin, &reporter);
    }

    #[test]
    #[should_panic(expected = "Price must be positive")]
    fn zero_price_is_rejected() {
        let (env, contract_id, admin, reporter) = setup();
        add_reporter(&env, &contract_id, &admin, &reporter);
        SimpleOracleClient::new(&env, &contract_id).report_price(&reporter, &0);
    }

    #[test]
    #[should_panic(expected = "Price must be positive")]
    fn negative_price_is_rejected() {
        let (env, contract_id, admin, reporter) = setup();
        add_reporter(&env, &contract_id, &admin, &reporter);
        SimpleOracleClient::new(&env, &contract_id).report_price(&reporter, &-1);
    }

    #[test]
    #[should_panic(expected = "Fallback price must be positive")]
    fn zero_fallback_is_rejected() {
        let (env, contract_id, admin, _) = setup();
        SimpleOracleClient::new(&env, &contract_id).set_fallback_price(&admin, &0);
    }

    #[test]
    fn observation_at_staleness_threshold_is_fresh() {
        let (env, contract_id, admin, reporter) = setup();
        env.ledger().set_sequence_number(100);
        let client = SimpleOracleClient::new(&env, &contract_id);
        add_reporter(&env, &contract_id, &admin, &reporter);
        client.report_price(&reporter, &80_000_000);
        env.ledger().set_sequence_number(100 + STALENESS_THRESHOLD);
        assert_eq!(client.get_price(), 8);
    }

    #[test]
    #[should_panic(expected = "Oracle price is stale and no fallback configured")]
    fn stale_observation_without_fallback_panics() {
        let (env, contract_id, admin, reporter) = setup();
        env.ledger().set_sequence_number(100);
        let client = SimpleOracleClient::new(&env, &contract_id);
        add_reporter(&env, &contract_id, &admin, &reporter);
        client.report_price(&reporter, &80_000_000);
        env.ledger().set_sequence_number(101 + STALENESS_THRESHOLD);
        client.get_price();
    }

    #[test]
    fn stale_observation_uses_fallback() {
        let (env, contract_id, admin, reporter) = setup();
        env.ledger().set_sequence_number(100);
        let client = SimpleOracleClient::new(&env, &contract_id);
        add_reporter(&env, &contract_id, &admin, &reporter);
        client.set_fallback_price(&admin, &7);
        client.report_price(&reporter, &80_000_000);
        env.ledger().set_sequence_number(101 + STALENESS_THRESHOLD);
        assert_eq!(client.get_price(), 7);
    }

    #[test]
    fn newest_observation_controls_freshness() {
        let (env, contract_id, admin, reporter) = setup();
        let client = SimpleOracleClient::new(&env, &contract_id);
        add_reporter(&env, &contract_id, &admin, &reporter);
        env.ledger().set_sequence_number(1);
        client.report_price(&reporter, &20_000_000);
        env.ledger().set_sequence_number(1_000);
        client.report_price(&reporter, &100_000_000);
        assert_eq!(client.get_price(), 6);
    }

    #[test]
    fn circular_buffer_overwrites_after_twenty_entries() {
        let (env, contract_id, admin, reporter) = setup();
        let client = SimpleOracleClient::new(&env, &contract_id);
        add_reporter(&env, &contract_id, &admin, &reporter);
        for price in 1_i128..=25 {
            client.report_price(&reporter, &(price * PRICE_SCALE));
        }
        assert_eq!(client.get_price(), 20);
        env.as_contract(&contract_id, || {
            let count: u32 = env
                .storage()
                .instance()
                .get(&DataKey::ObservationCount)
                .unwrap();
            let next_index: u32 = env
                .storage()
                .instance()
                .get(&DataKey::ObservationIndex)
                .unwrap();
            assert_eq!(count, MAX_OBSERVATIONS);
            assert_eq!(next_index, 5);
        });
    }

    #[test]
    fn twap_addition_overflow_panics() {
        let (env, contract_id, admin, reporter) = setup();
        let client = SimpleOracleClient::new(&env, &contract_id);
        add_reporter(&env, &contract_id, &admin, &reporter);
        client.report_price(&reporter, &i128::MAX);
        client.report_price(&reporter, &i128::MAX);
        assert!(client.try_get_price().is_err());
    }

    #[test]
    fn random_sequences_stay_within_recent_min_and_max() {
        let mut state = 0x5eed_u64;
        for _ in 0..32 {
            let (env, contract_id, admin, reporter) = setup();
            let client = SimpleOracleClient::new(&env, &contract_id);
            add_reporter(&env, &contract_id, &admin, &reporter);
            let mut recent = [0_i128; TWAP_WINDOW as usize];
            for index in 0..25_usize {
                state = state
                    .wrapping_mul(6_364_136_223_846_793_005)
                    .wrapping_add(1);
                let price = i128::from((state % 1_000) + 1);
                client.report_price(&reporter, &(price * PRICE_SCALE));
                if index >= 15 {
                    recent[index - 15] = price;
                }
            }
            let twap = client.get_price();
            let min = recent.iter().copied().min().unwrap();
            let max = recent.iter().copied().max().unwrap();
            assert!(twap >= min && twap <= max);
        }
    }

    // ── Slash history tests ──────────────────────────────────────────────

    #[test]
    #[should_panic(expected = "Only admin can perform this action")]
    fn non_admin_cannot_slash() {
        let (env, contract_id, _, reporter) = setup();
        let non_admin = Address::generate(&env);
        SimpleOracleClient::new(&env, &contract_id).slash_reporter(
            &non_admin,
            &reporter,
            &symbol_short!("bad"),
        );
    }

    #[test]
    fn slash_records_event_and_emits() {
        let (env, contract_id, admin, reporter) = setup();
        let client = SimpleOracleClient::new(&env, &contract_id);
        add_reporter(&env, &contract_id, &admin, &reporter);

        env.ledger().set_sequence_number(42);
        client.slash_reporter(&admin, &reporter, &symbol_short!("bad"));

        assert_eq!(client.get_slash_count(&reporter), 1);

        let event = client.get_slash_event_at(&reporter, &0);
        assert_eq!(event.at, 42);
        assert_eq!(event.slashed_by, admin);
        assert_eq!(event.reason, symbol_short!("bad"));
    }

    #[test]
    fn slash_count_is_zero_for_unslashed_reporter() {
        let (env, contract_id, _, reporter) = setup();
        let client = SimpleOracleClient::new(&env, &contract_id);
        assert_eq!(client.get_slash_count(&reporter), 0);
    }

    #[test]
    #[should_panic(expected = "Slash event slot is empty")]
    fn get_slash_event_at_panics_on_empty_slot() {
        let (env, contract_id, _, reporter) = setup();
        let client = SimpleOracleClient::new(&env, &contract_id);
        client.get_slash_event_at(&reporter, &0);
    }

    #[test]
    #[should_panic(expected = "Slash event index out of bounds")]
    fn get_slash_event_at_panics_on_out_of_bounds_index() {
        let (env, contract_id, _, reporter) = setup();
        let client = SimpleOracleClient::new(&env, &contract_id);
        client.get_slash_event_at(&reporter, &MAX_SLASH_HISTORY);
    }

    #[test]
    fn slash_history_is_bounded_at_max() {
        let (env, contract_id, admin, reporter) = setup();
        let client = SimpleOracleClient::new(&env, &contract_id);

        // Record MAX_SLASH_HISTORY + 5 events
        for seq in 1..=MAX_SLASH_HISTORY + 5 {
            env.ledger().set_sequence_number(seq);
            client.slash_reporter(&admin, &reporter, &symbol_short!("bad"));
        }

        // Count must never exceed MAX_SLASH_HISTORY
        assert_eq!(client.get_slash_count(&reporter), MAX_SLASH_HISTORY);

        // The ring-buffer metadata should show next_index has wrapped
        env.as_contract(&contract_id, || {
            let meta: SlashHistoryMeta = env
                .storage()
                .instance()
                .get(&DataKey::SlashHistoryMeta(reporter.clone()))
                .unwrap();
            assert_eq!(meta.count, MAX_SLASH_HISTORY);
            assert_eq!(meta.next_index, 5 % MAX_SLASH_HISTORY);
        });
    }

    #[test]
    fn slash_eviction_overwrites_oldest_entry() {
        let (env, contract_id, admin, reporter) = setup();
        let client = SimpleOracleClient::new(&env, &contract_id);

        // Write exactly MAX_SLASH_HISTORY events at known ledger sequences
        for seq in 1..=MAX_SLASH_HISTORY {
            env.ledger().set_sequence_number(seq);
            client.slash_reporter(&admin, &reporter, &symbol_short!("bad"));
        }

        // Record the event at slot 0 (should be seq=1)
        let first = client.get_slash_event_at(&reporter, &0);
        assert_eq!(first.at, 1);

        // Write one more — it should overwrite slot 0
        env.ledger().set_sequence_number(MAX_SLASH_HISTORY + 1);
        client.slash_reporter(&admin, &reporter, &symbol_short!("old"));
        let overwritten = client.get_slash_event_at(&reporter, &0);
        assert_eq!(overwritten.at, MAX_SLASH_HISTORY + 1);
        assert_eq!(overwritten.reason, symbol_short!("old"));
    }

    #[test]
    fn slash_events_use_different_reasons() {
        let (env, contract_id, admin, reporter) = setup();
        let client = SimpleOracleClient::new(&env, &contract_id);
        add_reporter(&env, &contract_id, &admin, &reporter);

        env.ledger().set_sequence_number(1);
        client.slash_reporter(&admin, &reporter, &symbol_short!("price"));
        env.ledger().set_sequence_number(2);
        client.slash_reporter(&admin, &reporter, &symbol_short!("spam"));

        assert_eq!(client.get_slash_count(&reporter), 2);
        assert_eq!(
            client.get_slash_event_at(&reporter, &0).reason,
            symbol_short!("price")
        );
        assert_eq!(
            client.get_slash_event_at(&reporter, &1).reason,
            symbol_short!("spam")
        );
    }

    #[test]
    fn slash_emits_event_for_off_chain_observers() {
        let (env, contract_id, admin, reporter) = setup();
        let client = SimpleOracleClient::new(&env, &contract_id);
        add_reporter(&env, &contract_id, &admin, &reporter);

        env.ledger().set_sequence_number(10);
        client.slash_reporter(&admin, &reporter, &symbol_short!("fraud"));

        // Verify the slash was recorded
        assert_eq!(client.get_slash_count(&reporter), 1);

        // Verify the event data is correct
        let event = client.get_slash_event_at(&reporter, &0);
        assert_eq!(event.at, 10);
        assert_eq!(event.slashed_by, admin);
        assert_eq!(event.reason, symbol_short!("fraud"));
    }
}
