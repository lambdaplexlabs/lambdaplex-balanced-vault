// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract ERC20Mock is ERC20 {

    uint8 public decimalsOverride;

    constructor(string memory name, string memory symbol, uint8 _decimals, uint256 initialMint) 
        ERC20(name, symbol) {
        decimalsOverride = _decimals;
        _mint(msg.sender, initialMint * 10 ** uint256(_decimals)); // Minting tokens
    }

    function decimals() override public view returns (uint8) {
        return decimalsOverride;
    }
}