// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.4.9 <0.9.0;
pragma experimental ABIEncoderV2;

import './IHieroAccountAllowanceHook.sol';

/// The interface for a transfer allowance lambda.
interface IOrderFlowAllowance is IHieroAccountAllowanceHook {

    /// Decides if the proposed transfers are allowed, optionally in
    /// the presence of additional context encoded by the transaction
    /// payer in the extra args.
    /// @param context The context of the transfer
    /// @param proposedTransfers The proposedTransfers
    /// @return true If the proposed transfers are allowed, false or revert otherwise
    function allow(
        IHieroHook.HookContext calldata context,
        ProposedTransfers memory proposedTransfers
    ) external payable returns (bool);
}