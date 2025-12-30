// SPDX-License-Identifier: MIT
pragma solidity >=0.8.4;

// Library to decode prefix key and order detail info

library Decoder {

    uint256 constant MASK63 = (uint256(1) << 63) - 1;

    // ---------------------- Prefix ----------------------------

    // The order prefix has the following format
    //     uint48 outToken;     // 8 bytes
    //     uint48 inToken;      // 8 bytes
    //     uint48 salt;         // 7 bytes
    //     uint32 expiration;   // 4 bytes
    //     uint24 feeBips;      // 3 bytes - note: out of 1e6 (1000 = 0.1% fee)
    //     uint8 orderType;      // 1 byte
    //     uint8 flags;         // 1 byte


    function orderType(uint256 prefix) internal pure returns (uint8) {
        return uint8((prefix >> 248) & 0xFF);
    }

    function flags(uint256 prefix) internal pure returns (uint8) {
        return uint8((prefix >> 240) & 0xFF);
    }

    function outToken(uint256 prefix) internal pure returns (address) {
        return address(uint160((prefix >> 176) & ((1 << 64) - 1)));
    }

    function inToken(uint256 prefix) internal pure returns (address) {
        return address(uint160((prefix >> 112) & ((1 << 64) - 1)));
    }

    function expiration(uint256 prefix) internal pure returns (uint32) {
        return uint32((prefix >> 80) & ((1 << 32) - 1));
    }

    function feeBips(uint256 prefix) internal pure returns (uint24) {
        return uint24((prefix >> 56) & ((1 << 24) - 1));
    }

    function salt(uint256 prefix) internal pure returns (uint56) {
        return uint56(prefix & ((1 << 56) - 1));
    }

    // ---------------------- Order Data ----------------------------

    // The order data has the following format
    //     uint256 quantity; // 63 bits
    //     uint256 numerator; // 63 bits
    //     uint256 denominator; // 63 bits
    //     uint256 slippage; // 63 bits

    function quantity(uint256 d) internal pure returns (uint256)   { return (d >> 193) & MASK63; }
    function numerator(uint256 d) internal pure returns (uint256)  { return (d >> 130) & MASK63; }
    function denominator(uint256 d) internal pure returns (uint256){ return (d >>  67) & MASK63; }
    function slippage(uint256 d) internal pure returns (uint256)   { return (d >>   4) & MASK63; }

    function encode(uint256 qty, uint256 num, uint256 den, uint256 slip) internal pure returns (bytes32 out) {
        uint256 v = (qty & MASK63) << 193
                  | (num & MASK63) << 130
                  | (den & MASK63) <<  67
                  | (slip & MASK63) <<   4;
        out = bytes32(v);
    }
}