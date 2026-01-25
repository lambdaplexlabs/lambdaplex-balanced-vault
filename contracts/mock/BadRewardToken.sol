// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @dev ERC20 that FAILS transfers when called by a specific address (e.g., Distributor).
///      - transferFrom works (so fund() works)
///      - transfer returns false for blockedSender (so distributor.claimTo() reverts via SafeERC20)
contract BadRewardToken is ERC20 {
    address public blockedSender;
    uint8 private _decimals;

    constructor(
        string memory name_,
        string memory symbol_,
        uint8 decimals_,
        address blockedSender_,
        uint256 initialSupply
    ) ERC20(name_, symbol_) {
        _decimals = decimals_;
        blockedSender = blockedSender_;
        _mint(msg.sender, initialSupply);
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    function transfer(address to, uint256 amount) public override returns (bool) {
        if (msg.sender == blockedSender) {
            return false; // causes SafeERC20.safeTransfer to revert with TRANSFER_FAILED
        }
        return super.transfer(to, amount);
    }
}