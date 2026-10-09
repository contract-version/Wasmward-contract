//! Upgrades the fixture the way it is upgraded on testnet: the built v1 Wasm is deployed, the built v2 Wasm
//! is uploaded, and `upgrade` swaps one for the other. The unit tests in `src/test.rs` run the contract as
//! native code and so cannot do this; this runs the compiled Wasm in the Soroban test host.
//!
//! It needs the two Wasm files, so it is ignored in a plain `cargo test`. Build them, then point the test at
//! them (this is what CI does):
//!
//! ```text
//! cargo build --release --target wasm32v1-none -p wasmward-fixture
//! cp target/wasm32v1-none/release/wasmward_fixture.wasm v1.wasm
//! cargo build --release --target wasm32v1-none -p wasmward-fixture --features v2
//! cp target/wasm32v1-none/release/wasmward_fixture.wasm v2.wasm
//! FIXTURE_V1_WASM=v1.wasm FIXTURE_V2_WASM=v2.wasm cargo test --test upgrade -- --ignored
//! ```

use soroban_sdk::{testutils::Address as _, Address, Bytes, BytesN, Env};
use wasmward_fixture::FixtureClient;

fn read_wasm(variable: &str) -> Vec<u8> {
    let path = std::env::var(variable)
        .unwrap_or_else(|_| panic!("set {variable} to the path of the built Wasm file"));
    std::fs::read(&path).unwrap_or_else(|error| panic!("cannot read {variable}={path}: {error}"))
}

fn upload(env: &Env, wasm: &[u8]) -> BytesN<32> {
    env.deployer()
        .upload_contract_wasm(Bytes::from_slice(env, wasm))
}

/// A fixture deployed from the v1 Wasm, with v2 already uploaded and its hash returned.
fn deployed() -> (Env, FixtureClient<'static>, BytesN<32>) {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let id = env.register(read_wasm("FIXTURE_V1_WASM").as_slice(), (&admin,));
    let v2 = upload(&env, &read_wasm("FIXTURE_V2_WASM"));
    (env.clone(), FixtureClient::new(&env, &id), v2)
}

#[test]
#[ignore = "needs FIXTURE_V1_WASM and FIXTURE_V2_WASM; see the top of this file"]
fn the_v1_wasm_reports_version_1() {
    let (_env, client, _v2) = deployed();
    assert_eq!(client.version(), 1);
}

#[test]
#[ignore = "needs FIXTURE_V1_WASM and FIXTURE_V2_WASM; see the top of this file"]
fn upgrading_to_the_v2_wasm_changes_what_the_contract_reports() {
    let (_env, client, v2) = deployed();
    assert_eq!(client.version(), 1);
    client.upgrade(&v2);
    assert_eq!(client.version(), 2);
}

#[test]
#[ignore = "needs FIXTURE_V1_WASM and FIXTURE_V2_WASM; see the top of this file"]
fn the_contract_address_does_not_change_when_it_is_upgraded() {
    let (_env, client, v2) = deployed();
    let before = client.address.clone();
    client.upgrade(&v2);
    assert_eq!(client.address, before);
}

#[test]
#[ignore = "needs FIXTURE_V1_WASM and FIXTURE_V2_WASM; see the top of this file"]
fn it_can_be_upgraded_back_to_v1_so_the_integration_test_can_run_again() {
    let (env, client, v2) = deployed();
    let v1 = upload(&env, &read_wasm("FIXTURE_V1_WASM"));
    client.upgrade(&v2);
    assert_eq!(client.version(), 2);
    // The admin is still recorded after the first upgrade, or this would fail.
    client.upgrade(&v1);
    assert_eq!(client.version(), 1);
}

#[test]
#[ignore = "needs FIXTURE_V1_WASM and FIXTURE_V2_WASM; see the top of this file"]
fn upgrading_to_a_hash_that_was_never_uploaded_fails_and_changes_nothing() {
    let (env, client, _v2) = deployed();
    let never_uploaded = BytesN::from_array(&env, &[7u8; 32]);
    assert!(client.try_upgrade(&never_uploaded).is_err());
    assert_eq!(client.version(), 1);
}

#[test]
#[ignore = "needs FIXTURE_V1_WASM and FIXTURE_V2_WASM; see the top of this file"]
fn the_compiled_wasm_also_refuses_an_upgrade_nobody_authorized() {
    let env = Env::default(); // no mock_all_auths: nobody has signed anything
    let admin = Address::generate(&env);
    let id = env.register(read_wasm("FIXTURE_V1_WASM").as_slice(), (&admin,));
    let v2 = upload(&env, &read_wasm("FIXTURE_V2_WASM"));
    let client = FixtureClient::new(&env, &id);
    assert!(client.try_upgrade(&v2).is_err());
    assert_eq!(client.version(), 1);
}
