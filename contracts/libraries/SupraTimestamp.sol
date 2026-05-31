// SPDX-License-Identifier: MIT
pragma solidity >=0.8.4;

/// @dev Supra proof payloads may encode timestamps in Unix milliseconds.
///      Normalize to seconds before comparing against block.timestamp.
library SupraTimestamp {
    uint256 private constant MILLIS_THRESHOLD = 1e12;

    function normalizeSeconds(uint256 timestamp) internal pure returns (uint256) {
        if (timestamp >= MILLIS_THRESHOLD) {
            return timestamp / 1000;
        }
        return timestamp;
    }
}