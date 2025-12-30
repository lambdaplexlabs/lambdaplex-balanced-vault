// SPDX-License-Identifier: MIT
pragma solidity >=0.8.4;

import '../interfaces/ISupraRegistry.sol';
import "@openzeppelin/contracts/access/Ownable.sol";

contract MockSupraPriceFeed {

    mapping(uint256 => PriceData) mockPriceDataMap;
    mapping(uint256 => PriceInfo) mockPriceInfoMap;

    struct PriceData {
        uint256[] pairs;
        uint256[] prices;
        uint256[] decimals;
    }

    struct PriceInfo {
        uint256[] pairs;
        uint256[] prices;
        uint256[] timestamp;
        uint256[] decimal;
        uint256[] round;
    }

    function setPriceData(uint256 id, uint256[] memory _pairs, uint256[] memory _prices, uint256[] memory _decimals) external {
        PriceData memory p;
        p.pairs = _pairs;
        p.prices = _prices;
        p.decimals = _decimals;

        mockPriceDataMap[id] = p;
    }

    function setPriceInfo(
        uint256 id, 
        uint256[] memory _pairs, 
        uint256[] memory _prices, 
        uint256[] memory _timestamp, 
        uint256[] memory _decimal,
        uint256[] memory _round
    ) external {
        PriceInfo memory p;
        p.pairs = _pairs;
        p.prices = _prices;
        p.timestamp = _timestamp;
        p.decimal = _decimal;
        p.round = _round;

        mockPriceInfoMap[id] = p;
    }

    function verifyOracleProof(bytes calldata _bytesproof) external view returns (PriceData memory) { // just takes uint256
        require(_bytesproof.length == 32, "mock supra: bad length");
        return mockPriceDataMap[abi.decode(_bytesproof, (uint256))];
    }

    // Below function (DORA2) verify the price and throws error if the proof is invalid. _bytesproof is the oracle proof to extract the pairs from Last Updated PriceData struct that does contain timestamp and round.  Stale prices can be determined using unixtimestamp.
    function verifyOracleProofV2(bytes calldata _bytesproof) external view returns (PriceInfo memory) {
        require(_bytesproof.length == 32, "mock supra: bad length");
        return mockPriceInfoMap[abi.decode(_bytesproof, (uint256))];
    }
}