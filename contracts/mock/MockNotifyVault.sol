// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @dev Minimal vault that just records the callback.
contract MockNotifyVault {
    address public lastToken;
    uint256 public lastAmount;
    uint256 public calls;

    event Notified(address token, uint256 netAmount);

    function onAirdropFunded(address token, uint256 netAmount) external {
        lastToken = token;
        lastAmount = netAmount;
        calls += 1;
        emit Notified(token, netAmount);
    }
}