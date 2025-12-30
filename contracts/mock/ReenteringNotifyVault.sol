// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IAirdropDistributor {
    function fund(address vault, address token, uint256 amount) external returns (uint256);
}

interface IERC20ApproveOnly {
    function approve(address spender, uint256 amount) external returns (bool);
}

/// @dev Calls back into distributor.fund() from inside onAirdropFunded.
///      Should revert with "reentrancy" and cause the outer fund() to revert atomically.
contract ReenteringNotifyVault {
    IAirdropDistributor public distributor;
    address public token;
    uint256 public amount;

    function arm(address distributor_, address token_, uint256 amount_) external {
        distributor = IAirdropDistributor(distributor_);
        token = token_;
        amount = amount_;
        IERC20ApproveOnly(token_).approve(distributor_, type(uint256).max);
    }

    function onAirdropFunded(address, uint256) external {
        // Attempt re-entry
        distributor.fund(address(this), token, amount);
    }
}