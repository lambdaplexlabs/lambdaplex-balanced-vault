// SPDX-License-Identifier: MIT
pragma solidity >=0.8.4;

import '../interfaces/IPLEXBrokerRegistry.sol';
import "@openzeppelin/contracts/access/Ownable.sol";

contract PLEXBrokerRegistry is IPLEXBrokerRegistry, Ownable {

    mapping(address => bool) private brokers;

    constructor(address _firstBroker) {
        brokers[_firstBroker] = true;
    }

    function setBroker(address addr, bool b) external onlyOwner() {
        brokers[addr] = b;
    }

    function isBroker(address addr) external view returns(bool) {
        return brokers[addr];
    }
}