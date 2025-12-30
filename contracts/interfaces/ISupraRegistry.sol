// SPDX-License-Identifier: MIT
pragma solidity >=0.8.4;

interface ISupraRegistry {

    //Verified price data
    struct PriceData {
        // List of pairs
        uint256[] pairs;
        // List of prices
        // prices[i] is the price of pairs[i]
        uint256[] prices;
        // List of decimals
        // decimals[i] is the decimals of pairs[i]
        uint256[] decimals;
    }

    struct PriceInfo {
        uint256[] pairs;
        uint256[] prices;
        uint256[] timestamp;
        uint256[] decimal;
        uint256[] round;
    }
    
    struct TokenPair {
        address tokenA;
        address tokenB;
        uint8 decimalsA;
        uint8 decimalsB;
    }
    
    function getPair(uint256 pairId) external returns (TokenPair memory);
    function changeSupraAddress(address _newSupra) external;
    function verifyOracleProof(bytes calldata _bytesproof) external returns (PriceData memory);
    function verifyOracleProofV2(bytes calldata _bytesproof) external returns (PriceInfo memory);
    function registerPair(
        uint256 pairId, 
        address tokenA, 
        address tokenB
    ) external;
}