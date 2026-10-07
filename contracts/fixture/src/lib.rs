#![no_std]

use soroban_sdk::{contract, contractimpl, contracttype, Address, BytesN, Env};

#[contracttype]
enum DataKey {
    Admin,
}

#[contract]
pub struct Fixture;

#[contractimpl]
impl Fixture {
    /// Runs once at deploy time and records the account allowed to upgrade the contract.
    pub fn __constructor(env: Env, admin: Address) {
        env.storage().instance().set(&DataKey::Admin, &admin);
    }

    /// Returns 1 for the default build and 2 for the `v2` feature build.
    pub fn version(_env: Env) -> u32 {
        if cfg!(feature = "v2") {
            2
        } else {
            1
        }
    }

    /// Replaces this contract's Wasm with an already uploaded one. Admin only.
    pub fn upgrade(env: Env, new_wasm_hash: BytesN<32>) {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("admin not set");
        admin.require_auth();
        env.deployer().update_current_contract_wasm(new_wasm_hash);
    }
}

#[cfg(test)]
mod test;
