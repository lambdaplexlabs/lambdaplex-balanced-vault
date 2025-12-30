// SPDX-License-Identifier: MIT
pragma solidity >=0.8.4;

import '../interfaces/ISupraRegistry.sol';
import "@openzeppelin/contracts/access/Ownable.sol";

interface IERC20 {
    function decimals() external returns(uint8);
}

contract SupraRegistry is ISupraRegistry, Ownable {

    ISupraRegistry public supra;
    mapping(uint256 => TokenPair) private pairs;

    constructor(address _supra) {
        supra = ISupraRegistry(_supra);
    }

    function changeSupraAddress(address _newSupra) external onlyOwner() {
        supra = ISupraRegistry(_newSupra);
    }

    function registerPair(
        uint256 pairId, 
        address tokenA, 
        address tokenB
    ) external onlyOwner() {
        require(tokenA != tokenB, 'IDENTICAL_ADDRESSES');
        pairs[pairId] = TokenPair(
            tokenA, 
            tokenB, 
            tokenA == address(0) ? 8 : IERC20(tokenA).decimals(), 
            tokenB == address(0) ? 8 : IERC20(tokenB).decimals());
    }

    function getPair(uint256 pairId) external view returns(TokenPair memory) {
        TokenPair storage p = pairs[pairId];
        return p;
    }

    function verifyOracleProof(bytes calldata _bytesproof) external returns (PriceData memory) {
        return supra.verifyOracleProof(_bytesproof);
    }

    function verifyOracleProofV2(bytes calldata _bytesproof) external returns (PriceInfo memory) {
        return supra.verifyOracleProofV2(_bytesproof);
    }
}