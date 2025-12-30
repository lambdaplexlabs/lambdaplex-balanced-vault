pragma solidity >=0.8.4;

interface IAirdropDistributor {
    /// @notice Fund an airdrop for `vault` in `token`, pulling `amount` from msg.sender (must approve).
    /// Returns the net amount credited to the vault after the owner cut and fee-on-transfer effects.
    function fund(address vault, address token, uint256 amount) external returns (uint256 netAmount);

    /// @notice Transfer `amount` of `token` from the distributor to `to`, debiting `vault`'s balance.
    /// Only callable by `vault`.
    function claimTo(address token, address to, uint256 amount) external;

    /// @notice Remaining undistributed balance for `vault` in `token`.
    function remaining(address vault, address token) external view returns (uint256);
}