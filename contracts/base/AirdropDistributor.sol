// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";
import "../interfaces/IERC20.sol";

/* Minimal guards (same pattern as in your vault) */
abstract contract ReentrancyGuard {
    uint256 private _entered;
    modifier nonReentrant() {
        require(_entered == 0, "reentrancy");
        _entered = 1; _;
        _entered = 0;
    }
}

interface IRewardNotifiableVault {
    /// @dev Distributor calls this after crediting the vault. MUST NOT call distributor in here.
    function onAirdropFunded(address token, uint256 netAmount) external;
}

library SafeERC20 {
    function safeTransfer(IERC20 t, address to, uint256 v) internal {
        bool ok = t.transfer(to, v); require(ok, "TRANSFER_FAILED");
    }
    function safeTransferFrom(IERC20 t, address from, address to, uint256 v) internal {
        bool ok = t.transferFrom(from, to, v); require(ok, "TRANSFER_FROM_FAILED");
    }
}

contract AirdropDistributor is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint64 public constant VESTING_SECS = 7 days;

    // whether a token can be used to fund a vault
    mapping(address => bool) public isTokenAllowed;
    // vault => token => credited (net after owner cut)
    mapping(address => mapping(address => uint256)) public credited;
    // vault => token => total sent via claimTo
    mapping(address => mapping(address => uint256)) public claimed;

    event Funded(
        address indexed vault,
        address indexed token,
        uint256 netCredited,
        uint64 vestingSecs
    );
    event Claimed(address indexed vault, address indexed user, address indexed token, uint256 amount);
    event TokenAllowed(address indexed token, bool allowed);

    error NotAllowedToken();
    error OnlyVault();
    error InsufficientBalance();

    function fund(address vault, address token, uint256 amount)
    external
    nonReentrant
    returns (uint256 netAmount)
    {
        require(vault != address(0) && token != address(0), "bad args");
        require(amount > 0, "amt=0");
        if (!isTokenAllowed[token]) revert NotAllowedToken();

        IERC20 rt = IERC20(token);
        uint256 before = rt.balanceOf(address(this));
        rt.safeTransferFrom(msg.sender, address(this), amount);
        require(rt.balanceOf(address(this)) - before == amount, "FOT_FORBIDDEN");

        // Credit net and atomically notify the vault
        netAmount = amount;
        credited[vault][token] += netAmount;

        IRewardNotifiableVault(vault).onAirdropFunded(token, netAmount);

        emit Funded(vault, token, netAmount, VESTING_SECS);
    }

    /// @notice Vault pays a user from its credited balance.
    function claimTo(address token, address to, uint256 amount) external nonReentrant {
        require(to != address(0) && amount > 0, "bad args");

        address vault = msg.sender;

        uint256 rem = credited[vault][token] - claimed[vault][token];
        if (amount > rem) revert InsufficientBalance();

        claimed[vault][token] += amount;
        IERC20(token).safeTransfer(to, amount);

        emit Claimed(vault, to, token, amount);
    }

    function remaining(address vault, address token) external view returns (uint256) {
        return credited[vault][token] - claimed[vault][token];
    }

    function associateToken(address token) external onlyOwner() {
        // Only owner may associate tokens
        ( , bytes memory result) = address(0x167).call(abi.encodeWithSignature("associateToken(address,address)", address(this), token));
        require (abi.decode(result, (int32)) == 22);
    }

    function modifyAllowed(address token, bool allowed) public onlyOwner() {
        isTokenAllowed[token] = allowed;
        emit TokenAllowed(token, allowed);
    }

    function dissociateToken(address token) external onlyOwner() {
        // Only owner may disassociate tokens
        ( , bytes memory result) = address(0x167).call(abi.encodeWithSignature("disassociateToken(address,address)", address(this), token));
        require (abi.decode(result, (int32)) == 22);
        modifyAllowed(token, false);
    }
}