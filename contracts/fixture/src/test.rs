use super::*;
use soroban_sdk::{testutils::Address as _, Address, BytesN, Env};

fn setup() -> (Env, FixtureClient<'static>, Address) {
    let env = Env::default();
    let admin = Address::generate(&env);
    let id = env.register(Fixture, (&admin,));
    let client = FixtureClient::new(&env, &id);
    (env, client, admin)
}

#[test]
fn version_matches_build_variant() {
    let (_env, client, _admin) = setup();
    let expected = if cfg!(feature = "v2") { 2 } else { 1 };
    assert_eq!(client.version(), expected);
}

#[test]
#[should_panic]
fn upgrade_requires_admin_auth() {
    let (env, client, _admin) = setup();
    // No auth is mocked, so the admin's require_auth() must fail before any upgrade happens.
    client.upgrade(&BytesN::from_array(&env, &[0u8; 32]));
}
