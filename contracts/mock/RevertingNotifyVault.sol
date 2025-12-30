// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @dev Always reverts on notification (tests atomicity of fund()).
contract RevertingNotifyVault {
    function onAirdropFunded(address, uint256) external pure {
        revert("VAULT_REVERT");
    }
}