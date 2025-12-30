// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import '../base/PLEXPairVault.sol';

contract MockPLEXPairVault is PLEXPairVault {

    constructor(
        address base_,
        address quote_,
        address oracleBase_,
        address oracleQuote_,
        address distributor_,
        uint32 ownerBips_
    ) PLEXPairVault(base_, quote_, oracleBase_, oracleQuote_, distributor_, ownerBips_) {

    }
}