// SPDX-License-Identifier: MIT
pragma solidity >=0.8.4;
import '../interfaces/IERC20.sol';

library SafeERC20 {
    function safeTransfer(IERC20 t, address to, uint256 v) internal {
        (bool success, bytes memory ret) =
            address(t).call(
                abi.encodeWithSelector(IERC20.transfer.selector, to, v)
            );
        require(success, "TRANSFER_CALL_FAILED");
        if (ret.length > 0) {
            require(abi.decode(ret, (bool)), "TRANSFER_FAILED");
        }
    }
    function safeTransferFrom(
        IERC20 t,
        address from,
        address to,
        uint256 v
    ) internal {
        (bool success, bytes memory ret) =
            address(t).call(
                abi.encodeWithSelector(IERC20.transferFrom.selector, from, to, v)
            );
        require(success, "TRANSFER_FROM_CALL_FAILED");
        if (ret.length > 0) {
            require(abi.decode(ret, (bool)), "TRANSFER_FROM_FAILED");
        }
    }
}