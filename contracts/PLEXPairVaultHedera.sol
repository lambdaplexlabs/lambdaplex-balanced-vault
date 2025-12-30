// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import './base/PLEXPairVault.sol';

contract PLEXPairVaultHedera is PLEXPairVault {

  address public immutable systemContract = address(0x167);

  constructor(
        address base_,
        address quote_,
        address oracleBase_,
        address oracleQuote_,
        address distributor_,
        uint32 ownerFeeBips_
  ) PLEXPairVault (
        base_,
        quote_,
        oracleBase_,
        oracleQuote_,
        distributor_,
        ownerFeeBips_
  ) {
    // associate tokens to this vault
    address[] memory tokens = new address[](2);
    tokens[0] = base_;
    tokens[1] = quote_;

    ( , bytes memory result) = systemContract.call(abi.encodeWithSignature("associateTokens(address,address[])", address(this), tokens));
        require (abi.decode(result, (int32)) == 22);
  }
}
