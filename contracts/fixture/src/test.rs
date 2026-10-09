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
#[should_panic(expected = "Error(Auth, InvalidAction)")]
fn upgrade_requires_admin_auth() {
    let (env, client, _admin) = setup();
    // No auth is mocked, so the admin's require_auth() must fail before any upgrade happens.
    client.upgrade(&BytesN::from_array(&env, &[0u8; 32]));
}

#[test]
#[should_panic(expected = "Error(Auth, InvalidAction)")]
fn upgrade_rejects_a_signer_who_is_not_the_admin() {
    use soroban_sdk::{
        testutils::{MockAuth, MockAuthInvoke},
        IntoVal,
    };

    let (env, client, _admin) = setup();
    let other = Address::generate(&env);
    let hash = BytesN::from_array(&env, &[0u8; 32]);
    // A valid signature from someone else must not satisfy the admin's require_auth().
    client
        .mock_auths(&[MockAuth {
            address: &other,
            invoke: &MockAuthInvoke {
                contract: &client.address,
                fn_name: "upgrade",
                args: (hash.clone(),).into_val(&env),
                sub_invokes: &[],
            },
        }])
        .upgrade(&hash);
}

#[test]
fn constructor_records_the_admin() {
    let (env, client, admin) = setup();
    let stored: Option<Address> = env.as_contract(&client.address, || {
        env.storage().instance().get(&DataKey::Admin)
    });
    assert_eq!(stored, Some(admin));
}

#[test]
#[should_panic(expected = "Error(Auth, InvalidAction)")]
fn one_deployments_admin_cannot_upgrade_another() {
    use soroban_sdk::{
        testutils::{MockAuth, MockAuthInvoke},
        IntoVal,
    };

    let (env, first, first_admin) = setup();
    let second_admin = Address::generate(&env);
    let second_id = env.register(Fixture, (&second_admin,));
    let second = FixtureClient::new(&env, &second_id);
    assert_ne!(first.address, second.address);

    let hash = BytesN::from_array(&env, &[0u8; 32]);
    // The first deployment's admin signs, but the call goes to the second deployment, whose admin is someone else.
    second
        .mock_auths(&[MockAuth {
            address: &first_admin,
            invoke: &MockAuthInvoke {
                contract: &second.address,
                fn_name: "upgrade",
                args: (hash.clone(),).into_val(&env),
                sub_invokes: &[],
            },
        }])
        .upgrade(&hash);
}

#[test]
fn each_deployment_keeps_its_own_admin() {
    let (env, first, first_admin) = setup();
    let second_admin = Address::generate(&env);
    let second_id = env.register(Fixture, (&second_admin,));

    let stored = |id: &Address| -> Option<Address> {
        env.as_contract(id, || env.storage().instance().get(&DataKey::Admin))
    };
    assert_eq!(stored(&first.address), Some(first_admin));
    assert_eq!(stored(&second_id), Some(second_admin));
}

#[test]
fn version_needs_no_authorization_and_does_not_change_between_calls() {
    let (_env, client, _admin) = setup();
    // No auth is mocked anywhere in this test, so a read that needed one would fail.
    assert_eq!(client.version(), client.version());
}
