// SPDX-License-Identifier: MIT
pragma solidity >=0.8.4;

interface IPLEXBrokerRegistry {

    function setBroker(address broker, bool isBroker) external;
    function isBroker(address addr) external returns(bool);
}