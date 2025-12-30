// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IAirdropDistributor {
    function claimTo(address token, address to, uint256 amount) external;
}

/// @dev Minimal vault for distributor tests:
/// - implements onAirdropFunded so distributor.fund() succeeds
/// - can call claimTo as itself
contract MockVaultWithClaim {
    IAirdropDistributor public distributor;

    address public lastToken;
    uint256 public lastAmount;
    uint256 public calls;

    constructor(address distributor_) {
        distributor = IAirdropDistributor(distributor_);
    }

    function onAirdropFunded(address token, uint256 netAmount) external {
        lastToken = token;
        lastAmount = netAmount;
        calls += 1;
    }

    function claim(address token, address to, uint256 amount) external {
        distributor.claimTo(token, to, amount);
    }

    /// @dev Negative-testing helper: pass the "wrong" vault param on purpose.
    function claimAs(address token, address to, uint256 amount) external {
        distributor.claimTo(token, to, amount);
    }
}