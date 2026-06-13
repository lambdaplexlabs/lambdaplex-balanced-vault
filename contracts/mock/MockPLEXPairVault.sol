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
        address manager_,
        uint32 ownerFeeBips_,
        uint64 vestingSecs_,
        uint64 lockupSecs_,
        uint64 feeChangeDelaySecs_,
        uint32 initialBalanceTolBips_
    ) PLEXPairVault(
        base_,
        quote_,
        oracleBase_,
        oracleQuote_,
        distributor_,
        manager_,
        ownerFeeBips_,
        vestingSecs_,
        lockupSecs_,
        feeChangeDelaySecs_,
        initialBalanceTolBips_
    ) {

    }
}