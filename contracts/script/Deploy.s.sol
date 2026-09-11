// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";

import {AttestationRegistry} from "../src/AttestationRegistry.sol";
import {IAdmissibleRegistry} from "../src/IAdmissibleRegistry.sol";
import {CredentialGatedPool} from "../src/examples/CredentialGatedPool.sol";

/// @title  Deploy
/// @notice Deploys the Admissible registry and its example consumer to Creditcoin CC3 testnet
///         (chain id 102031).
///
/// @dev    Usage:
///           forge script contracts/script/Deploy.s.sol:Deploy \
///             --rpc-url $CREDITCOIN_RPC --broadcast --legacy
///
///         `AttestationRegistry` takes no constructor arguments: the two canonical EAS deployments
///         are seeded inside the constructor so the security-critical addresses cannot be supplied
///         wrongly at deploy time. This script asserts them afterwards and reverts the whole
///         broadcast if either is off by a byte.
contract Deploy is Script {
    /// @dev Canonical EAS deployments, per SPEC.md §3.
    address internal constant EAS_SEPOLIA = 0xC2679fBD37d54388Ce493F1DB75320D236e1815e;
    address internal constant EAS_MAINNET = 0xA1207F3BBa224E2c9c3c6D5aF63D0eb1582Ce587;

    uint64 internal constant CHAIN_KEY_SEPOLIA = 1;
    uint64 internal constant CHAIN_KEY_MAINNET = 3;

    /// @dev The pool is deployed pointing at Ethereum mainnet attestations with wildcard
    ///      attester/schema, so it is usable the moment any attestation is mirrored. The owner
    ///      tightens it to a specific issuer via `setCredentialRequirement` for the demo.
    uint64 internal constant POOL_CHAIN_KEY = CHAIN_KEY_MAINNET;
    uint256 internal constant POOL_BORROW_CAP = 10 ether;

    /// @notice Deploy both contracts and verify the seeded EAS addresses on-chain.
    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);

        console2.log("chainid  ", block.chainid);
        console2.log("deployer ", deployer);
        console2.log("balance  ", deployer.balance);

        vm.startBroadcast(deployerKey);

        AttestationRegistry registry = new AttestationRegistry();

        CredentialGatedPool pool = new CredentialGatedPool(
            IAdmissibleRegistry(address(registry)),
            POOL_CHAIN_KEY,
            address(0),   // requiredAttester — wildcard until the demo issuer is known
            bytes32(0),   // requiredSchema   — wildcard until the demo schema is known
            POOL_BORROW_CAP
        );

        vm.stopBroadcast();

        // Fail the deployment loudly rather than shipping a registry that would accept forged logs.
        require(registry.easAddress(CHAIN_KEY_SEPOLIA) == EAS_SEPOLIA, "Deploy: sepolia EAS mis-seeded");
        require(registry.easAddress(CHAIN_KEY_MAINNET) == EAS_MAINNET, "Deploy: mainnet EAS mis-seeded");
        require(registry.owner() == deployer, "Deploy: unexpected registry owner");
        require(address(pool.registry()) == address(registry), "Deploy: pool not wired to registry");

        console2.log("registry ", address(registry));
        console2.log("pool     ", address(pool));
    }
}
