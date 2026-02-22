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
      require(base_ != quote_, 'base = quote');
      bool success; 
      bytes memory result;
      if (base_ != address(0) && quote_ != address(0)) {
            address[] memory tokens = new address[](2);
            tokens[0] = base_;
            tokens[1] = quote_;

            (success, result) = systemContract.call(abi.encodeWithSignature("associateTokens(address,address[])", address(this), tokens));
      }
      else {
            (success, result) = systemContract.call(abi.encodeWithSignature(
                  "associateToken(address,address)", 
                  address(this),
                  base_ < quote_ ? quote_ : base_
            ));
      }
      require(success, "HTS Precompile: CALL_EXCEPTION");
      int32 responseCode = abi.decode(result, (int32));
      require(responseCode == 22, "HTS Precompile: CALL_ERROR");
  }
}
