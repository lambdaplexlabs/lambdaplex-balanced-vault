// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/math/SafeCast.sol";
import "../libraries/PRBMathCommon.sol";
import "../libraries/SafeERC20.sol";
import "../interfaces/IAirdropDistributor.sol";
import "../interfaces/IERC20.sol";
import "../interfaces/ISupraRegistry.sol";

/* ─────────────────────────── Utilities ─────────────────────────── */

abstract contract ReentrancyGuard {
    uint256 private _entered;
    modifier nonReentrant() {
        require(_entered == 0, "reentrancy");
        _entered = 1;
        _;
        _entered = 0;
    }
}

interface IOwnable {
    function owner() external view returns (address);
}

/* ───────────────────────── Vault: Single Pair ───────────────────────── */

contract PLEXPairVault is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /* ── Pair config ── */
    // If BASE or QUOTE equals address(0), that side is native HBAR.
    address public immutable BASE;
    address public immutable QUOTE;

    // Supra oracle registry (used for pricing BASE→QUOTE)
    ISupraRegistry public immutable supra =
        ISupraRegistry(address(0x00000000000000000000000000000000000003f7));
        
    address public immutable ORACLE_BASE;
    address public immutable ORACLE_QUOTE;
    uint256 constant STALE_PRICE = 30;

    // Distributor that custodies reward tokens and pays on claim
    IAirdropDistributor public distributor;
    event DistributorSet(address indexed distributor);

    // Fixed vesting for airdrops (enforced in distributor; vault uses the same environment value)
    uint64 public immutable vestingSecs;

    // Deposit lockup (rewards accrue immediately; withdrawal gated)
    uint64 public immutable lockupSecs;

    // Delay between scheduling a fee change and it becoming active.
    uint64 public immutable feeChangeDelaySecs;

    /* ── Global math scales ── */
    uint256 public constant BPS = 1_000_000; // 1e6 = 100%
    uint64 public constant WEEK_SECS = 7 days;

    /* ── Max reward token to prevent unbounded array growth ── */
    uint256 public constant MAX_REWARD_TOKENS = 30;

    /* ── Donation/inflation mitigation (ERC4626-style virtual offset) ── */
    uint256 private constant VIRTUAL_SHARES = 1e3;
    uint256 private constant VIRTUAL_VALUEQ = 1;

    /* ── Shares (global) ── */
    uint256 public totalShares;
    mapping(address => uint256) public userShares;

    /* ── Inventory rebalancing configuration ── */
    uint32 public balanceTolBips;
    event BalanceToleranceSet(uint32 tolBips);

    /* ── Emergency mode (price oracle failure) ── */
    bool public emergencyMode;
    event EmergencyModeEnabled(address indexed by);

    enum DepState {
        ACTIVE,
        WITHDRAWN
    }

    struct Deposit {
        address user;
        uint96 shares;
        uint64 createdAt;
        uint64 lockupUntil; // createdAt + lockupSecs
        uint8 state; // DepState
    }

    Deposit[] public deposits;

    // Track user lots (to enable partial withdrawals per-lot)
    mapping(address => uint256[]) public _userDeposits;

    /* ── Streaming Airdrops ─────────────────────────
         slot0: perShare (uint256)
         slot1: rate (uint256)
         slot2: carry (uint128) | lastUpdate (uint64) | periodFinish (uint64)
         slot3: campaignStart (uint64)
    */
    struct RewardData {
        uint256 perShare; // cumulative tokens per eligible share (1e18 scale)
        uint256 rate; // tokens per second
        uint128 carry; // tokens accrued when no eligible shares (or rounding)
        uint64 lastUpdate; // last time perShare was updated
        uint64 periodFinish; // stream end time
        uint64 campaignStart; // first funding time for the currently active stream
    }
    struct UserReward {
        uint256 perSharePaid;
        uint256 accrued;
    }

    address[] public rewardTokens; // max length = MAX_REWARD_TOKENS 
    mapping(address => RewardData) public rewards; // rewardToken => RewardData
    mapping(address => mapping(address => UserReward)) public userRewards; // user => rewardToken => UserReward

    /* ── Continuous management fee: share‑minting model ─────────────────── */
    uint32 public constant MAX_OWNER_FEE_BIPS = 3_000; // 0.3% per week

    uint32 public ownerFeeBips; // currently effective weekly rate (ppm over BPS)
    uint32 public pendingOwnerFeeBips; // next rate to take effect (0 if none)
    uint64 public pendingOwnerFeeTs; // unix timestamp when pending becomes active (0 if none)

    uint64 public lastFeeChangeTs; // last time owner scheduled a fee change
    uint64 public lastFeeAccrual; // last timestamp we accrued fee

    uint256 public ownerFeeShares; // fee‑shares minted to owner (excluded from userShares)

    event OwnerFeeRateScheduled(uint32 newBips, uint64 effectiveTs);
    event OwnerFeeRateApplied(
        uint32 previousBips,
        uint32 newBips,
        uint64 effectiveTs
    );
    event OwnerFeeAccrued(
        uint256 sharesMinted,
        uint64 fromTs,
        uint64 toTs,
        uint32 rateBips
    );
    event OwnerFeeRedeemed(
        uint256 sharesBurned,
        uint256 baseOut,
        uint256 quoteOut
    );

    /* ── Events ── */
    event DepositedPolicy(
        address indexed user,
        uint256 indexed depositId,
        uint256 baseIn,
        uint256 quoteIn,
        uint256 sharesMinted,
        uint256 tvlQuoteBefore
    );
    event WithdrawalFinalized(
        uint256 indexed depositId,
        address indexed user,
        uint256 baseOut,
        uint256 quoteOut,
        uint256 sharesBurned
    );

    // Streaming airdrops
    event RewardStreamConfigured(
        address indexed rewardToken,
        uint256 amountNet,
        uint64 campaignStart,
        uint64 vestingSecs,
        uint256 newRate,
        uint256 carry,
        uint64 periodFinish
    );
    event RewardClaimed(
        address indexed rewardToken,
        address indexed user,
        uint256 amount
    );
    event RewardClaimFailed(
        address indexed rewardToken, 
        address indexed user, 
        uint256 amount
    );

    constructor(
        address base_,
        address quote_,
        address oracleBase_,
        address oracleQuote_,
        address distributor_,
        uint32 ownerFeeBips_,
        uint64 vestingSecs_,
        uint64 lockupSecs_,
        uint64 feeChangeDelaySecs_,
        uint32 initialBalanceTolBips_
    ) {
        require(base_ != quote_, "pair identical");
        require(vestingSecs_ > 0, "vesting=0");
        require(initialBalanceTolBips_ <= 50_000, "tol too high");
        require(lockupSecs_ > 0, "lockup=0");
        require(feeChangeDelaySecs_ >= 1 days, "delay too short");

        BASE = base_;
        QUOTE = quote_;
        ORACLE_BASE = oracleBase_;
        ORACLE_QUOTE = oracleQuote_;
        vestingSecs = vestingSecs_;
        lockupSecs = lockupSecs_;
        feeChangeDelaySecs = feeChangeDelaySecs_;
        balanceTolBips = initialBalanceTolBips_;

        if (distributor_ != address(0)) {
            distributor = IAirdropDistributor(distributor_);
            emit DistributorSet(distributor_);
        }
        lastFeeAccrual = uint64(block.timestamp);
        require(ownerFeeBips_ <= MAX_OWNER_FEE_BIPS, "rate>0.3%");
        ownerFeeBips = ownerFeeBips_;
    }

    /* ───────────────────────── Admin ───────────────────────── */

    function setBalanceToleranceBips(uint32 bips) external onlyOwner {
        require(bips <= 50_000, "tol too high"); // cap at 5%
        balanceTolBips = bips;
        emit BalanceToleranceSet(bips);
    }

    /// @notice Schedule a new weekly management fee rate (ppm, capped at 0.3%/week).
    ///         The new rate becomes effective after `feeChangeDelaySecs`,
    ///         and the owner may only schedule again after another full delay window.
    function scheduleOwnerFeeBips(uint32 newBips) external onlyOwner {
        require(newBips <= MAX_OWNER_FEE_BIPS, "rate>0.3%");

        // Bring fee accrual fully up to date and apply any past pending change.
        _accrueMgmtFee();

        uint64 nowTs = uint64(block.timestamp);

        // Cooldown: only one change per rolling delay window.
        require(
            lastFeeChangeTs == 0 || nowTs >= lastFeeChangeTs + feeChangeDelaySecs,
            "fee change cooldown"
        );

        pendingOwnerFeeBips = newBips;
        pendingOwnerFeeTs = nowTs + feeChangeDelaySecs;
        lastFeeChangeTs = nowTs;

        emit OwnerFeeRateScheduled(newBips, pendingOwnerFeeTs);
    }

    /// @notice Info for frontends / off-chain monitoring.
    function ownerFeeInfo()
        external
        view
        returns (
            uint32 currentBips,
            uint32 pendingBips,
            uint64 pendingEffectiveTs,
            uint64 lastChangeTs,
            uint64 lastAccrualTs,
            uint256 feeShares
        )
    {
        uint64 nowTs = uint64(block.timestamp);

        // If pending is already effective by "now", treat it as the current rate.
        uint32 effBips = ownerFeeBips;
        if (pendingOwnerFeeTs != 0 && nowTs >= pendingOwnerFeeTs) {
            effBips = pendingOwnerFeeBips;
        }

        currentBips = effBips;
        pendingBips = pendingOwnerFeeBips;
        pendingEffectiveTs = pendingOwnerFeeTs;
        lastChangeTs = lastFeeChangeTs;
        lastAccrualTs = lastFeeAccrual;
        feeShares = ownerFeeShares;
    }

    /* ───────────────────────── Token helpers ───────────────────────── */

    function _vaultBalance(address token) internal view returns (uint256) {
        return
            token == address(0)
                ? address(this).balance
                : IERC20(token).balanceOf(address(this));
    }

    function _transferOut(
        address token,
        address payable to,
        uint256 amount
    ) internal {
        if (amount == 0) return;
        if (token == address(0)) {
            (bool ok, ) = to.call{value: amount}("");
            require(ok, "HBAR_TRANSFER_FAILED");
        } else {
            IERC20(token).safeTransfer(to, amount);
        }
    }

    /* ───────────────────────── Oracle helpers (Supra) ───────────────────────── */

    /// @dev Returns (priceScaled, scale) where priceScaled = QUOTE per BASE, scaled by `scale`.
    /// Accepts either orientation from Supra; inverts if needed while keeping the same scale.
    function _getPriceAndScale(
        bytes memory args
    ) internal returns (uint256 price, uint256 scale) {
        ISupraRegistry.PriceInfo memory info;
        try supra.verifyOracleProofV2(args) returns (
            ISupraRegistry.PriceInfo memory verified
        ) {
            info = verified;
        } catch Error(string memory reason) {
            revert(string.concat("oracle: verify reverted: ", reason));
        } catch {
            revert("oracle: verify call failed");
        }
        require(info.pairs.length == 1, "oracle: pairs!=1");

        // --- Freshness checks ---
        uint64 t = uint64(info.timestamp[0]);
        uint64 nowU = uint64(block.timestamp);
        require(t != 0, "oracle: ts=0");
        require(t <= nowU, "oracle: future");
        require(nowU - t <= STALE_PRICE, "oracle: stale");

        // --- Pair identity checks ---
        ISupraRegistry.TokenPair memory tokenPair;
        try supra.getPair(info.pairs[0]) returns (
            ISupraRegistry.TokenPair memory pair
        ) {
            tokenPair = pair;
        } catch Error(string memory reason) {
            revert(string.concat("oracle: getPair reverted: ", reason));
        } catch {
            revert("oracle: getPair call failed");
        }
        bool normal = (tokenPair.tokenA == ORACLE_BASE &&
            tokenPair.tokenB == ORACLE_QUOTE);
        bool inverse = (tokenPair.tokenA == ORACLE_QUOTE &&
            tokenPair.tokenB == ORACLE_BASE);
        require(normal || inverse, "oracle: wrong pair");

        // --- Scale & raw price ---
        uint256 dec = info.decimal[0];
        require(dec <= 77, "oracle: dec too big");
        scale = 10 ** dec;
        require(scale > 0, "oracle: scale=0");

        uint256 rawPrice = info.prices[0]; // P
        require(rawPrice > 0, "oracle: price=0");

        if (normal) {
            // tokenA = BASE, tokenB = QUOTE
            uint8 dBase = tokenPair.decimalsA;
            uint8 dQuote = tokenPair.decimalsB;

            // price / scale = QUOTE_units / BASE_unit
            price = PRBMathCommon.mulDiv(
                rawPrice,
                10 ** dQuote, // QUOTE decimals
                10 ** dBase // BASE decimals
            );
        } else {
            // inverse: tokenA = QUOTE, tokenB = BASE
            uint8 dQuote = tokenPair.decimalsA;
            uint8 dBase = tokenPair.decimalsB;

            // price / scale = QUOTE_units / BASE_unit
            //
            // price = (scale^2 * 10^(dQuote - dBase)) / rawPrice
            // implemented as two mulDiv steps to avoid overflow:
            uint256 num = PRBMathCommon.mulDiv(scale, 10 ** dQuote, rawPrice); // S * 10^dQuote / P

            price = PRBMathCommon.mulDiv(num, scale, 10 ** dBase); // (S^2 * 10^dQuote) / (P * 10^dBase)
        }
    }

    /* ───────────────────────── Inventory helpers ───────────────────────── */

    function _ceilDiv(uint256 a, uint256 b) internal pure returns (uint256) {
        return a == 0 ? 0 : ((a - 1) / b) + 1;
    }

    /// @dev Returns inventory values in QUOTE units and signed imbalance (>0 = BASE overweight; <0 = QUOTE overweight).
    function _inventoryValuesFromBalances(
        uint256 baseBal,
        uint256 quoteBal,
        uint256 price,
        uint256 scale
    )
        internal
        pure
        returns (
            uint256 outBaseBal,
            uint256 outQuoteBal,
            uint256 baseValQ,
            uint256 quoteValQ,
            uint256 tvlQ,
            int256 imbalanceQ
        )
    {
        outBaseBal = baseBal;
        outQuoteBal = quoteBal;
        baseValQ = (baseBal * price) / scale;
        quoteValQ = quoteBal;
        tvlQ = baseValQ + quoteValQ;

        // Safe signed difference
        if (baseValQ >= quoteValQ) {
            imbalanceQ = int256(baseValQ - quoteValQ);
        } else {
            imbalanceQ = -int256(quoteValQ - baseValQ);
        }
    }

    /// @dev Returns inventory values in QUOTE units and signed imbalance (>0 = BASE overweight; <0 = QUOTE overweight).
    function _inventoryValues(
        uint256 price,
        uint256 scale
    )
        internal
        view
        returns (
            uint256 baseBal,
            uint256 quoteBal,
            uint256 baseValQ,
            uint256 quoteValQ,
            uint256 tvlQ,
            int256 imbalanceQ
        )
    {
        return
            _inventoryValuesFromBalances(
                _vaultBalance(BASE),
                _vaultBalance(QUOTE),
                price,
                scale
            );
    }

    /* ───────────────────────── Virtual share helpers ───────────────────────── */
    function _valueQToShares(uint256 valueQ, uint256 tvlQ, uint256 supply)
        internal
        pure
        returns (uint256)
    {
        // shares = valueQ * (supply + VIRTUAL_SHARES) / (tvlQ + VIRTUAL_VALUEQ)
        return PRBMathCommon.mulDiv(valueQ, supply + VIRTUAL_SHARES, tvlQ + VIRTUAL_VALUEQ);
    }

    function _sharesToValueQ(uint256 shares, uint256 tvlQ, uint256 supply)
        internal
        pure
        returns (uint256)
    {
        // valueQ = shares * (tvlQ + VIRTUAL_VALUEQ) / (supply + VIRTUAL_SHARES)
        return PRBMathCommon.mulDiv(shares, tvlQ + VIRTUAL_VALUEQ, supply + VIRTUAL_SHARES);
    }

    /// @dev True if |imbalance| <= tolerance * TVL.
    function _isBalanced(
        uint256 tvlQ,
        int256 imbalanceQ
    ) internal view returns (bool) {
        if (tvlQ == 0) return true;
        uint256 absImb = uint256(imbalanceQ >= 0 ? imbalanceQ : -imbalanceQ);
        return absImb * BPS <= tvlQ * uint256(balanceTolBips);
    }

    /// @dev Compute a payout that (1) consumes the overweight side by value up to min(owed, overweight),
    ///      then (2) pays the remaining owed value 50/50 by value.
    ///      Reverts if the vault lacks enough of one side to honor the 50/50 remainder.
    ///      `imbalanceValueQ` is in QUOTE units (>0 => BASE overweight, <0 => QUOTE overweight).
    function _payoutOverweightThenBalanced(
        uint256 owedValueQ,
        uint256 priceQPerBase,
        uint256 priceScale,
        uint256 baseBalance,
        uint256 quoteBalance,
        int256 imbalanceValueQ
    ) internal pure returns (uint256 basePay, uint256 quotePay) {
        // -------- Phase 1: consume overweight by value --------
        if (imbalanceValueQ > 0) {
            // BASE is overweight by `overweightValueQ` (in QUOTE units)
            uint256 overweightValueQ = uint256(imbalanceValueQ);

            // Cover up to the smaller of (owedValueQ, overweightValueQ) using BASE only
            uint256 phase1ValueQ = owedValueQ <= overweightValueQ
                ? owedValueQ
                : overweightValueQ;
            uint256 phase1BaseUnits = (phase1ValueQ * priceScale) /
                priceQPerBase; // floor to BASE units

            require(phase1BaseUnits <= baseBalance, "BASE liquidity too low");

            baseBalance -= phase1BaseUnits;
            owedValueQ -= phase1ValueQ;
            basePay = phase1BaseUnits;
        } else if (imbalanceValueQ < 0) {
            // QUOTE is overweight by `overweightValueQ` (in QUOTE units)
            uint256 overweightValueQ = uint256(-imbalanceValueQ);

            // Cover up to the smaller of (owedValueQ, overweightValueQ) using QUOTE only
            uint256 phase1ValueQ = owedValueQ <= overweightValueQ
                ? owedValueQ
                : overweightValueQ;

            require(phase1ValueQ <= quoteBalance, "QUOTE liquidity too low");

            quoteBalance -= phase1ValueQ;
            owedValueQ -= phase1ValueQ;
            quotePay = phase1ValueQ;
        }

        // -------- Phase 2: split the remaining owed value 50/50 by value --------
        if (owedValueQ == 0) return (basePay, quotePay);

        uint256 halfRemainderValueQ = owedValueQ / 2;

        // Convert half the remaining value into BASE units (floor),
        // then compute the exact QUOTE value those BASE units represent.
        // Start from the strict 50/50 target, but cap by live BASE inventory so a quote-only
        // exact fill remains possible when the remainder is too small to need BASE at all.
        uint256 phase2BaseUnits = (halfRemainderValueQ * priceScale) /
            priceQPerBase;
        if (phase2BaseUnits > baseBalance) {
            phase2BaseUnits = baseBalance;
        }
        uint256 phase2BaseValueQ = (phase2BaseUnits * priceQPerBase) /
            priceScale;

        // If the BASE leg rounded down too aggressively, or if the 50/50 target exceeds the
        // available BASE inventory, bump BASE just enough so the remaining QUOTE leg fits exactly.
        uint256 minPhase2BaseValueQ = owedValueQ > quoteBalance
            ? owedValueQ - quoteBalance
            : 0;
        if (phase2BaseValueQ < minPhase2BaseValueQ) {
            phase2BaseUnits = _ceilDiv(
                minPhase2BaseValueQ * priceScale,
                priceQPerBase
            );
            require(phase2BaseUnits <= baseBalance, "insufficient liquidity");
            phase2BaseValueQ = (phase2BaseUnits * priceQPerBase) /
                priceScale;
            require(phase2BaseValueQ <= owedValueQ, "insufficient liquidity");
        }

        // Whatever QUOTE value remains after paying the BASE leg is paid in QUOTE units.
        uint256 phase2QuoteUnits = owedValueQ - phase2BaseValueQ;

        // Require sufficient balances to honor the strict 50/50 remainder
        require(
            phase2BaseUnits <= baseBalance && phase2QuoteUnits <= quoteBalance,
            "insufficient liquidity"
        );

        basePay += phase2BaseUnits;
        quotePay += phase2QuoteUnits;
    }

    /* ───────────────────────── Streaming Rewards ───────────────────────── */

    function _ensureListedReward(address rt) internal {
        for (uint i = 0; i < rewardTokens.length; i++)
            if (rewardTokens[i] == rt) return;
        require(rewardTokens.length < MAX_REWARD_TOKENS, "too many reward tokens");
        rewardTokens.push(rt);
    }

    /// @dev Eligible denominator EXCLUDES ownerFeeShares to avoid diluting depositor rewards.
    function _eligibleShares() internal view returns (uint256) {
        uint256 ts = totalShares;
        uint256 fee = ownerFeeShares;
        return ts > fee ? (ts - fee) : 0;
    }

    /// @dev Rewards accrue immediately to eligible shares (no warm-up).
    function _updateReward(address rt) internal {
        RewardData storage R = rewards[rt];
        uint64 t = uint64(block.timestamp);
        uint64 capped = t < R.periodFinish ? t : R.periodFinish;
        if (capped > R.lastUpdate) {
            uint256 dt = uint256(capped - R.lastUpdate);
            if (dt > 0) {
                uint256 eligible = _eligibleShares();
                if (eligible == 0) {
                    R.carry += SafeCast.toUint128(R.rate * dt);
                } else {
                    R.perShare += (R.rate * dt * 1e18) / eligible;
                }
            }
            R.lastUpdate = capped;
            if (capped == R.periodFinish) {
                R.rate = 0; // stream ended
            }
        }
    }

    /// @dev Settle all reward tokens for `user` against current perShare.
    ///      IMPORTANT: even if `userShares[user] == 0`, we still checkpoint `perSharePaid`
    ///      so new depositors do NOT accrue past rewards.
    function _settleRewards(address user) internal {
        uint256 len = rewardTokens.length;
        if (len == 0) return;

        uint256 sh = userShares[user];

        for (uint256 i = 0; i < len; i++) {
            address rt = rewardTokens[i];

            _updateReward(rt); // advances global perShare to "now"
            RewardData storage R = rewards[rt];
            UserReward storage U = userRewards[user][rt];

            if (sh != 0) {
                uint256 delta = R.perShare - U.perSharePaid;
                if (delta != 0) {
                    U.accrued += (sh * delta) / 1e18;
                }
            }

            // Always checkpoint so users can't earn rewards from before they held shares
            U.perSharePaid = R.perShare;
        }
    }

    /// @notice Distributor calls this after funding: blend with existing stream using "hold finish if active".
    function onAirdropFunded(address rewardToken, uint256 netAmount) external {
        require(msg.sender == address(distributor), "only distributor");
        require(rewardToken != address(0), "HBAR reward unsupported");
        require(netAmount > 0, "net=0");

        _accrueMgmtFee(); // checkpoint fee‑shares first
        _updateReward(rewardToken); // settle time to now before reconfig
        _ensureListedReward(rewardToken);

        RewardData storage R = rewards[rewardToken];
        uint64 nowU64 = uint64(block.timestamp);

        // leftover from current stream after settlement (if still active)
        uint256 leftover = 0;
        if (nowU64 < R.periodFinish && R.rate > 0) {
            leftover = R.rate * uint256(R.periodFinish - nowU64);
        }

        // combine with carry + new funding
        uint256 totalToStream = leftover + uint256(R.carry) + netAmount;

        if (nowU64 < R.periodFinish) {
            // ACTIVE: keep finish, raise rate over remaining time
            uint256 remainingTime = uint256(R.periodFinish - nowU64);
            if (R.campaignStart == 0) {
                R.campaignStart = nowU64;
            }
            R.rate = totalToStream / remainingTime;
            R.carry = SafeCast.toUint128(totalToStream - R.rate * remainingTime);
            R.lastUpdate = nowU64; // finish unchanged
            emit RewardStreamConfigured(
                rewardToken,
                netAmount,
                R.campaignStart,
                uint64(remainingTime),
                R.rate,
                R.carry,
                R.periodFinish
            );
        } else {
            // INACTIVE: start fresh configured stream
            R.rate = totalToStream / vestingSecs;
            R.carry = SafeCast.toUint128(totalToStream - R.rate * vestingSecs);
            R.lastUpdate = nowU64;
            R.campaignStart = nowU64;
            R.periodFinish = nowU64 + vestingSecs;
            emit RewardStreamConfigured(
                rewardToken,
                netAmount,
                R.campaignStart,
                vestingSecs,
                R.rate,
                R.carry,
                R.periodFinish
            );
        }
    }

    /// @notice Claim a specific reward token. Paid from Distributor to caller.
    function claimRewards(address rewardToken) external nonReentrant {
        require(address(distributor) != address(0), "distributor not set");
        _settleRewards(msg.sender);
        UserReward storage U = userRewards[msg.sender][rewardToken];
        uint256 amt = U.accrued;
        U.accrued = 0;
        if (amt > 0) {
            distributor.claimTo(rewardToken, msg.sender, amt);
            emit RewardClaimed(rewardToken, msg.sender, amt);
        }
    }

    /// @notice Claim all reward tokens. Paid from Distributor to caller.
    function claimAllRewards() external nonReentrant {
        require(address(distributor) != address(0), "distributor not set");
        _settleRewards(msg.sender);
        for (uint i = 0; i < rewardTokens.length; i++) {
            address rt = rewardTokens[i];
            UserReward storage U = userRewards[msg.sender][rt];
            uint256 amt = U.accrued;
            if (amt > 0) {
                try distributor.claimTo(rt, msg.sender, amt) {
                    U.accrued = 0;
                    emit RewardClaimed(rt, msg.sender, amt);
                } catch {
                    emit RewardClaimFailed(rt, msg.sender, amt);
                // Leave U.accrued intact for retry via claimRewards(rt)
                }
            }
        }
    }
    /* ───────────────────────── Views ───────────────────────── */

    function depositsLength() external view returns (uint256) {
        return deposits.length;
    }
    function depositsOf(address user) external view returns (uint256[] memory) {
        return _userDeposits[user];
    }

    /// @notice Preview the exact amounts the vault would accept from the user's caps under the
    ///         two‑phase inventory policy in a single call.
    ///         Phase 1 (if imbalanced by value): accept only the UNDERWEIGHT token up to the
    ///         amount needed to reach (or slightly breach due to rounding) a 50/50 value split.
    ///         Phase 2 (if caps remain): accept additional liquidity strictly as a 50/50‑by‑value pair.
    /// @param baseDesired  Maximum BASE units the user is willing to provide.
    /// @param quoteDesired Maximum QUOTE units the user is willing to provide.
    /// @param price        Oracle price: QUOTE per BASE, scaled by `scale`.
    /// @param scale        Oracle scale (e.g., 1e8).
    /// @return baseAccept  BASE units the vault will accept now.
    /// @return quoteAccept QUOTE units the vault will accept now.
    /// @return mode        0=BASE-only (still imbalanced), 1=QUOTE-only (still imbalanced),
    ///                     2=balanced (50/50-only), 3=underweight+balanced paired.
    function previewDepositRequiredGivenPrice(
        uint256 baseDesired,
        uint256 quoteDesired,
        uint256 price,
        uint256 scale
    )
        external
        view
        returns (uint256 baseAccept, uint256 quoteAccept, uint8 mode)
    {
        return _previewDepositRequired(baseDesired, quoteDesired, price, scale);
    }

    /// @notice Same as previewDepositRequiredGivenPrice, but consumes a live Supra proof (non-view).
    function previewDepositRequiredLive(
        uint256 baseDesired,
        uint256 quoteDesired,
        bytes memory supraArgs
    ) external returns (uint256 baseAccept, uint256 quoteAccept, uint8 mode) {
        (uint256 price, uint256 scale) = _getPriceAndScale(supraArgs);
        return _previewDepositRequired(baseDesired, quoteDesired, price, scale);
    }

    /// @notice Preview withdrawal composition under the balancing policy (by value).
    /// @param shares user's shares to withdraw
    /// @param price QUOTE per BASE (scaled by `scale`)
    /// @param scale oracle scale
    function previewWithdrawalPayoutGivenPrice(
        uint256 shares,
        uint256 price,
        uint256 scale
    ) external view returns (uint256 baseOut, uint256 quoteOut) {
        require(shares > 0 && totalShares > 0, "bad shares");

        // Get live inventories & imbalance (we don’t need baseValQ/quoteValQ here)
        (
            uint256 baseBal,
            uint256 quoteBal,
            ,
            , // skip baseValQ, quoteValQ
            uint256 tvlQ,
            int256 imb
        ) = _inventoryValues(price, scale);

        uint256 tsBefore = totalShares;
        // Pro-rata value owed (QUOTE terms)
        uint256 valueOutQ = _sharesToValueQ(shares, tvlQ, tsBefore);

        // One source of truth: handles both balanced & imbalanced
        return
            _payoutOverweightThenBalanced(
                valueOutQ,
                price,
                scale,
                baseBal,
                quoteBal,
                imb
            );
    }

    /* ───────────────────────── Deposit slot allocator (free-list) ───────────────────────── */

    function _allocDepositSlot() internal returns (uint256 id) {
        id = deposits.length;
        deposits.push(); // extend; we'll write fields below
    }

    /**
    * @dev Fully delete a deposit record once it is completely withdrawn.
    *      The depositId is never reused; external code should treat a
    *      zeroed-out deposit as "non-existent / closed".
    */
    function _deleteDeposit(uint256 id) internal {
        delete deposits[id];
    }

    function _removeUserDeposit(address user, uint256 id) internal {
        uint256[] storage arr = _userDeposits[user];
        for (uint256 i = 0; i < arr.length; i++) {
            if (arr[i] == id) {
                uint256 last = arr.length - 1;
                if (i != last) arr[i] = arr[last];
                arr.pop();
                break;
            }
        }
    }
    /* ───────────────────────── Deposits (policy) ───────────────────────── */

    /// @dev helper: pair additional liquidity in 50/50 by value using remaining caps.
    function _pair50_50(
        uint256 remBase,
        uint256 remQuote,
        uint256 price,
        uint256 scale
    ) internal pure returns (uint256 b2, uint256 q2) {
        if (remBase == 0 || remQuote == 0) return (0, 0);
        uint256 bCapByQuote = (remQuote * scale) / price; // floor
        b2 = remBase < bCapByQuote ? remBase : bCapByQuote;
        q2 = (b2 * price) / scale; // exact value match on QUOTE side
    }

    /// @dev Internal preview: two‑phase acceptance:
    ///      (1) top up underweight side to 50/50 by value; (2) accept extra as 50/50.
    function _previewDepositRequired(
        uint256 baseDesired,
        uint256 quoteDesired,
        uint256 price,
        uint256 scale
    )
        internal
        view
        returns (uint256 baseAccept, uint256 quoteAccept, uint8 mode)
    {
        return
            _previewDepositRequiredFromBalances(
                baseDesired,
                quoteDesired,
                price,
                scale,
                _vaultBalance(BASE),
                _vaultBalance(QUOTE)
            );
    }

    /// @dev Same as _previewDepositRequired but allows the caller to provide explicit inventory balances.
    function _previewDepositRequiredFromBalances(
        uint256 baseDesired,
        uint256 quoteDesired,
        uint256 price,
        uint256 scale,
        uint256 baseBal,
        uint256 quoteBal
    )
        internal
        view
        returns (uint256 baseAccept, uint256 quoteAccept, uint8 mode)
    {
        (
            ,
            ,
            uint256 baseValQ,
            uint256 quoteValQ,
            uint256 tvlQ,
            int256 imb
        ) = _inventoryValuesFromBalances(baseBal, quoteBal, price, scale);

        bool balanced = _isBalanced(tvlQ, imb);

        if (balanced) {
            if (baseDesired == 0 || quoteDesired == 0) {
                return (0, 0, 2);
            }
            uint256 baseDesiredValQ = (baseDesired * price) / scale;
            // Case A: Quote cap is NOT the bottleneck.
            if (baseDesiredValQ <= quoteDesired) {
                // We can take all BASE the user wants and the matching QUOTE to keep 50/50.
                return (baseDesired, baseDesiredValQ, 2);
            } else {
                // Case B: Quote cap IS the bottleneck.
                // Convert the quote cap back into the maximum BASE we can pair 1:1 by value.
                uint256 b = (quoteDesired * scale) / price; // floor

                // Then compute the exact matching QUOTE from that BASE to keep 50/50 by value.
                return (b, (b * price) / scale, 2);
            }
        }

        // Imbalanced → two‑phase
        if (imb < 0) {
            // BASE underweight: need ΔQ = quoteValQ - baseValQ (value, QUOTE units)
            uint256 needQ = quoteValQ - baseValQ;
            uint256 needBase = _ceilDiv(needQ * scale, price); // ceil units to reach/breach 50/50

            // Phase 1: take up to needBase in BASE
            uint256 phase1Base = baseDesired < needBase
                ? baseDesired
                : needBase;
            baseAccept = phase1Base;

            if (phase1Base < needBase) {
                // Still imbalanced; cannot accept QUOTE
                return (baseAccept, 0, 0); // BASE-only
            }

            // Phase 2: balanced (or slightly over); accept extra 50/50 using remaining caps
            uint256 remBase = baseDesired - phase1Base;
            uint256 remQuote = quoteDesired;
            if (remBase == 0 || remQuote == 0) {
                return (baseAccept, 0, 3);
            }
            (uint256 b2, uint256 q2) = _pair50_50(
                remBase,
                remQuote,
                price,
                scale
            );
            baseAccept = phase1Base + b2;
            quoteAccept = q2;
            return (baseAccept, quoteAccept, 3);
        } else {
            // QUOTE underweight: need ΔQ = baseValQ - quoteValQ (already in QUOTE units)
            uint256 needQuote = baseValQ - quoteValQ;

            // Phase 1: take up to needQuote in QUOTE
            uint256 phase1Quote = quoteDesired < needQuote
                ? quoteDesired
                : needQuote;
            quoteAccept = phase1Quote;

            if (phase1Quote < needQuote) {
                // Still imbalanced; cannot accept BASE
                return (0, quoteAccept, 1); // QUOTE-only
            }

            // Phase 2: balanced; accept extra 50/50 using remaining caps
            uint256 remBase = baseDesired;
            uint256 remQuote = quoteDesired - phase1Quote;
            if (remBase == 0 || remQuote == 0) {
                return (0, quoteAccept, 3);
            }
            (uint256 b2, uint256 q2) = _pair50_50(
                remBase,
                remQuote,
                price,
                scale
            );
            quoteAccept = phase1Quote + q2;
            baseAccept = b2;
            return (baseAccept, quoteAccept, 3);
        }
    }

    /// @notice Deposit with inventory policy enforcement:
    ///         - If imbalanced: first top-up underweight to 50/50; then accept extra as 50/50.
    ///         - If balanced: accept only a 50/50-by-value split.
    /// Pass `baseMax`/`quoteMax` as user's caps and `minBaseAccept`/`minQuoteAccept` as slippage bounds.
    /// For native HBAR, `msg.value` is treated as a max funding amount; any excess is refunded to `msg.sender`.
    /// FOT (fee-on-transfer) tokens are forbidden: pulls must be exact-in.
    function depositWithPolicy(
        uint256 baseMax,
        uint256 quoteMax,
        uint256 minBaseAccept,
        uint256 minQuoteAccept,
        bytes memory supraArgs
    ) external payable nonReentrant returns(uint256) {
        require(!emergencyMode, "emergency: deposits disabled");
        require(minBaseAccept <= baseMax, "slippage: base bounds");
        require(minQuoteAccept <= quoteMax, "slippage: quote bounds");
        _accrueMgmtFee(); // checkpoint fee‑shares first
        (uint256 price, uint256 scale) = _getPriceAndScale(supraArgs);

        // Use pre-call balances for policy preview (address(this).balance already includes msg.value).
        uint256 balBaseBefore = _vaultBalance(BASE);
        uint256 balQuoteBefore = _vaultBalance(QUOTE);
        if (BASE == address(0)) {
            require(balBaseBefore >= msg.value, "HBAR accounting");
            balBaseBefore -= msg.value;
        }
        if (QUOTE == address(0)) {
            require(balQuoteBefore >= msg.value, "HBAR accounting");
            balQuoteBefore -= msg.value;
        }

        // Preview what we will accept right now
        (uint256 baseAcc, uint256 quoteAcc, ) = _previewDepositRequiredFromBalances(
            baseMax,
            quoteMax,
            price,
            scale,
            balBaseBefore,
            balQuoteBefore
        );

        require(baseAcc >= minBaseAccept, "slippage: base");
        require(quoteAcc >= minQuoteAccept, "slippage: quote");
        require(baseAcc > 0 || quoteAcc > 0, "nothing accepted");

        // Required HBAR (bounded by msg.value; any excess is refunded at the end)
        uint256 requiredHBAR = 0;
        if (BASE == address(0)) requiredHBAR += baseAcc;
        if (QUOTE == address(0)) requiredHBAR += quoteAcc;
        require(msg.value >= requiredHBAR, "HBAR<required");

        // Pre-balances for TVL-before.

        // Pull funds (FOT forbidden: must receive exactly requested)
        if (baseAcc > 0 && BASE != address(0)) {
            uint256 pre = IERC20(BASE).balanceOf(address(this));
            IERC20(BASE).safeTransferFrom(msg.sender, address(this), baseAcc);
            require(
                IERC20(BASE).balanceOf(address(this)) - pre == baseAcc,
                "FOT_FORBIDDEN:BASE"
            );
        }
        if (quoteAcc > 0 && QUOTE != address(0)) {
            uint256 pre = IERC20(QUOTE).balanceOf(address(this));
            IERC20(QUOTE).safeTransferFrom(msg.sender, address(this), quoteAcc);
            require(
                IERC20(QUOTE).balanceOf(address(this)) - pre == quoteAcc,
                "FOT_FORBIDDEN:QUOTE"
            );
        }

        // Price the principal (QUOTE terms) and TVL BEFORE this deposit
        uint256 principalQ = (baseAcc * price) / scale + quoteAcc;
        uint256 tvlQBefore = ((balBaseBefore * price) / scale) + balQuoteBefore;

        // Settle rewards for user before mutating (rewards accrue immediately)
        _settleRewards(msg.sender);

        uint256 supplyBefore = totalShares;

        // Mint shares using virtual offset mitigation
        uint256 sh = _valueQToShares(principalQ, tvlQBefore, supplyBefore);
        require(sh > 0, "shares=0");
        require(sh <= type(uint96).max, "shares overflow");

        // Create deposit lot with configured lockup
        uint256 depId = _allocDepositSlot();
        uint64 nowU64 = uint64(block.timestamp);
        Deposit storage d = deposits[depId];
        d.user = msg.sender;
        d.shares = uint96(sh);
        d.createdAt = nowU64;
        d.lockupUntil = nowU64 + lockupSecs;
        d.state = uint8(DepState.ACTIVE);
        _userDeposits[msg.sender].push(depId);

        // Update supplies
        totalShares += sh;
        userShares[msg.sender] += sh;

        emit DepositedPolicy(msg.sender, depId, baseAcc, quoteAcc, sh, tvlQBefore);

        uint256 refundHBAR = msg.value - requiredHBAR;
        if (refundHBAR != 0) {
            (bool refundOk, ) = payable(msg.sender).call{value: refundHBAR}("");
            require(refundOk, "HBAR_REFUND_FAILED");
        }

        return depId;
    }

    /* ───────────────────────── Withdrawals (instant) ───────────────────────── */

    /// @notice Withdraw `sharesToBurn` from a deposit lot immediately after lockup.
    /// Pays by value using the inventory policy:
    ///         - If imbalanced: pays from overweight token first (fallback to the other).
    ///         - If balanced: pays 50/50 by value.
    function withdrawFromDeposit(
        uint256 depositId,
        uint256 sharesToBurn,
        bytes memory supraArgs
    ) public nonReentrant {
        _accrueMgmtFee(); // checkpoint fee‑shares first

        Deposit storage d = deposits[depositId];
        address user = d.user;
        require(user == msg.sender, "not owner");
        require(d.state == uint8(DepState.ACTIVE), "withdrawn");
        require(block.timestamp >= d.lockupUntil, "locked");
        require(sharesToBurn > 0 && sharesToBurn <= uint256(d.shares), "bad shares");

        // Settle streaming rewards before burning shares
        _settleRewards(user);

        uint256 sh = sharesToBurn;
        uint256 tsBefore = totalShares;
        require(tsBefore >= sh, "supply");

        (uint256 price, uint256 scale) = _getPriceAndScale(supraArgs);

        (uint256 baseBal, uint256 quoteBal, , , uint256 tvlQ, int256 imb)
            = _inventoryValues(price, scale);

        uint256 valueOutQ = _sharesToValueQ(sh, tvlQ, tsBefore);

        (uint256 payBase, uint256 payQuote) = _payoutOverweightThenBalanced(
            valueOutQ, price, scale, baseBal, quoteBal, imb
        );

        // Burn shares
        d.shares = uint96(uint256(d.shares) - sh);
        totalShares = tsBefore - sh;
        uint256 us = userShares[user];
        userShares[user] = us >= sh ? (us - sh) : 0;

        // If lot emptied, mark withdrawn and recycle
        if (d.shares == 0) {
            d.state = uint8(DepState.WITHDRAWN);
            _removeUserDeposit(user, depositId);
            _deleteDeposit(depositId);
        }

        _transferOut(BASE,  payable(user), payBase);
        _transferOut(QUOTE, payable(user), payQuote);

        emit WithdrawalFinalized(depositId, user, payBase, payQuote, sh);
    }

    /// @notice Convenience: withdraw the entire lot.
    function withdrawAllFromDeposit(
        uint256 depositId,
        bytes memory supraArgs
    ) external {
        uint256 sh = deposits[depositId].shares;
        withdrawFromDeposit(depositId, sh, supraArgs);
    }

    /* ───────────────────────── Owner fee‑shares redemption ───────────────────────── */

    /// @notice Owner can redeem already‑accrued fee‑shares for BASE/QUOTE at any time.
    function ownerRedeemFees(
        uint256 feeSharesToBurn,
        uint256 baseAmountMin,
        uint256 quoteAmountMin,
        bytes memory supraArgs
    ) external onlyOwner nonReentrant {
        _accrueMgmtFee(); // ensure all vesting up to now is minted

        uint256 available = ownerFeeShares;
        uint256 burn = feeSharesToBurn > available
            ? available
            : feeSharesToBurn;
        require(burn > 0, "no feeShares");

        uint256 tsBefore = totalShares;
        require(tsBefore >= burn, "supply");

        // Oracle price
        (uint256 price, uint256 scale) = _getPriceAndScale(supraArgs);

        // Inventories/values (current)
        (
            uint256 baseBal,
            uint256 quoteBal,
            ,
            ,
            uint256 tvlQ,
            int256 imb
        ) = _inventoryValues(price, scale);

        // Value owed (QUOTE terms)
        uint256 valueOutQ = _sharesToValueQ(burn, tvlQ, tsBefore);

        // Compute payout per policy (handles both imbalanced and balanced)
        (uint256 payBase, uint256 payQuote) = _payoutOverweightThenBalanced(
            valueOutQ,
            price,
            scale,
            baseBal,
            quoteBal,
            imb
        );

        // Add slippage protection checks
        require(payBase >= baseAmountMin, "slippage: base");
        require(payQuote >= quoteAmountMin, "slippage: quote");

        // Burn fee‑shares and shrink total supply
        ownerFeeShares = available - burn;
        totalShares = tsBefore - burn;

        // Payout to owner
        _transferOut(BASE, payable(owner()), payBase);
        _transferOut(QUOTE, payable(owner()), payQuote);

        emit OwnerFeeRedeemed(burn, payBase, payQuote);
    }

    /* ───────────────────────── Native receive ───────────────────────── */

    receive() external payable {}

    /* ───────────────────────── Internal: fee accrual ───────────────────────── */

    function _effectiveFeeBipsView(
        uint64 /* currentWeek */
    ) internal view returns (uint32) {
        return
            (pendingOwnerFeeTs != 0 &&
                uint64(block.timestamp) >= pendingOwnerFeeTs)
                ? pendingOwnerFeeBips
                : ownerFeeBips;
    }

    function _applyPendingFee(uint64 effectiveTs) internal {
        uint32 previousBips = ownerFeeBips;
        uint32 nextBips = pendingOwnerFeeBips;
        ownerFeeBips = nextBips;
        pendingOwnerFeeBips = 0;
        pendingOwnerFeeTs = 0;
        emit OwnerFeeRateApplied(previousBips, nextBips, effectiveTs);
    }

    function _applyPendingFeeIfDue(uint64 nowTs) internal {
        uint64 effTs = pendingOwnerFeeTs;
        if (effTs != 0 && nowTs >= effTs) {
            _applyPendingFee(effTs);
        }
    }

    /// @dev Accrue management fee by minting owner fee‑shares over elapsed time.
    ///      Uses ΔS = S * num / (den - num), where num = rateBips * Δt, den = BPS * WEEK_SECS.
    ///      Segments precisely if a scheduled rate change becomes effective inside [lastFeeAccrual, now].
    function _accrueMgmtFee() internal {
        uint64 nowTs = uint64(block.timestamp);
        uint64 _lastFeeAccrual = lastFeeAccrual;
        if (nowTs <= _lastFeeAccrual) return;

        // If no depositor shares, don't build "backlog": just move the clock and possibly apply pending.
        if (totalShares == 0) {
            lastFeeAccrual = nowTs;
            _applyPendingFeeIfDue(nowTs);
            return;
        }

        uint64 effTs = pendingOwnerFeeTs;

        if (effTs != 0 && _lastFeeAccrual < effTs && nowTs > effTs) {
            // segment 1: [last, effTs) at current ownerFeeBips
            _accrueLinear(_lastFeeAccrual, effTs, ownerFeeBips);

            // switch to pending rate
            _applyPendingFee(effTs);

            // segment 2: [effTs, nowTs) at new ownerFeeBips
            _accrueLinear(effTs, nowTs, ownerFeeBips);
        } else {
            // Either entirely before the pending change, or after it's already effective.
            _applyPendingFeeIfDue(nowTs);
            _accrueLinear(_lastFeeAccrual, nowTs, ownerFeeBips);
        }

        lastFeeAccrual = nowTs;
    }

    /// @dev Accrue linearly for [fromTs, toTs) at `rateBips`.
    ///      Chunks Δt to ensure f < 1 (i.e., num < den) to keep formula stable.
    function _accrueLinear(
        uint64 fromTs,
        uint64 toTs,
        uint32 rateBips
    ) internal {
        if (toTs <= fromTs) return;
        if (rateBips == 0) return;

        uint256 den = BPS * uint256(WEEK_SECS);
        // Max Δt per chunk so that num < den always holds.
        uint64 maxDt = uint64((den / rateBips) - 1); // ~6.4 years at 0.3%/week

        uint64 t = fromTs;
        while (t < toTs) {
            uint64 chunkEnd = toTs - t > maxDt ? t + maxDt : toTs;
            uint64 dt = chunkEnd - t;

            // Skip if no depositor shares
            uint256 S = totalShares;
            if (S != 0) {
                uint256 num = uint256(rateBips) * uint256(dt);
                // ΔS = S * num / (den - num)
                uint256 dS = (S * num) / (den - num);

                if (dS != 0) {
                    totalShares = S + dS;
                    ownerFeeShares += dS;
                    emit OwnerFeeAccrued(dS, t, chunkEnd, rateBips);
                }
            }

            t = chunkEnd;
        }
    }

    /* ───────────────────────── Emergency mode ───────────────────────── */

    /// @notice Permanently enable emergency mode. One-way; cannot be disabled.
    ///         Authorized: vault owner OR distributor.owner() (if distributor is Ownable).
    function enableEmergencyMode() external {
        require(!emergencyMode, "emergency: already enabled");

        address d = address(distributor);
        address dOwner = address(0);
        if (d != address(0)) {
            // If distributor is Ownable, read its owner; ignore if it reverts or returns nothing.
            try IOwnable(d).owner() returns (address o) {
                dOwner = o;
            } catch {
                /* leave dOwner = address(0) */
            }
        }

        require(
            msg.sender == owner() ||
                (dOwner != address(0) && msg.sender == dOwner),
            "emergency: not authorized"
        );
        emergencyMode = true;
        emit EmergencyModeEnabled(msg.sender);
    }

    /// @notice Emergency withdraw: burn the lot's shares and return strict pro‑rata
    ///         portions of BASE and QUOTE currently held by the vault (no oracle).
    ///         Ignores lockup and inventory policy. Available only when emergencyMode == true.
    function emergencyWithdrawFromDeposit(uint256 depositId) public nonReentrant {
        require(emergencyMode, "emergency: disabled");

        Deposit storage d = deposits[depositId];
        address user = d.user;
        require(user == msg.sender, "not owner");
        require(d.state == uint8(DepState.ACTIVE), "withdrawn");
        uint256 sh = d.shares;
        require(sh > 0, "no shares");

        // Keep accounting current (both are oracle-free)
        _accrueMgmtFee();
        _settleRewards(user);

        uint256 tsBefore = totalShares;
        require(tsBefore >= sh, "supply");

        // Snapshot balances and compute per-token pro-rata
        uint256 baseBal  = _vaultBalance(BASE);
        uint256 quoteBal = _vaultBalance(QUOTE);
        uint256 baseOut  = (baseBal  * sh) / tsBefore;
        uint256 quoteOut = (quoteBal * sh) / tsBefore;

        // Burn user's shares and update totals
        d.shares = 0;
        d.state  = uint8(DepState.WITHDRAWN);
        totalShares = tsBefore - sh;
        uint256 us = userShares[d.user];
        userShares[d.user] = us >= sh ? (us - sh) : 0;

        // Remove from user's list and delete the record permanently
        _removeUserDeposit(d.user, depositId);
        _deleteDeposit(depositId);

        // Payout (HBAR / Token)
        _transferOut(BASE,  payable(user), baseOut);
        _transferOut(QUOTE, payable(user), quoteOut);

        emit WithdrawalFinalized(depositId, user, baseOut, quoteOut, sh);
    }

    /// @notice Emergency redemption of already‑accrued owner fee‑shares for per‑token pro‑rata.
    ///         Available only when emergencyMode == true.
    function ownerRedeemFeesEmergency(
        uint256 feeSharesToBurn
    ) external onlyOwner nonReentrant {
        require(emergencyMode, "emergency: disabled");
        require(
            feeSharesToBurn > 0 && feeSharesToBurn <= ownerFeeShares,
            "bad feeShares"
        );

        _accrueMgmtFee();

        uint256 tsBefore = totalShares;
        require(tsBefore >= feeSharesToBurn, "supply");

        uint256 baseBal = _vaultBalance(BASE);
        uint256 quoteBal = _vaultBalance(QUOTE);
        uint256 baseOut = (baseBal * feeSharesToBurn) / tsBefore;
        uint256 quoteOut = (quoteBal * feeSharesToBurn) / tsBefore;

        ownerFeeShares -= feeSharesToBurn;
        totalShares = tsBefore - feeSharesToBurn;

        _transferOut(BASE, payable(owner()), baseOut);
        _transferOut(QUOTE, payable(owner()), quoteOut);

        emit OwnerFeeRedeemed(feeSharesToBurn, baseOut, quoteOut);
    }
}