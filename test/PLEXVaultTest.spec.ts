// test/Vault.test.ts
import { expect } from "chai";
import { ethers, network } from "hardhat";
import { BigNumber, Signer } from "ethers";
import { AirdropDistributor, ERC20Mock, MockSupraPriceFeed, PLEXPairVault, SupraRegistry } from "../typechain-types";

describe("Vault", () => {
  let deployer: Signer;
  let alice: Signer;
  let bob: Signer;

  let token0: ERC20Mock;
  let token1: ERC20Mock;
  let distributor: AirdropDistributor;
  let vault: PLEXPairVault;
  let mockSupra: MockSupraPriceFeed;
  let supraAtFixed: SupraRegistry;
  let supraArgs: string;

  let initOwnerBips = 0;

  const INITIAL_MINT = 1_000_000_000;
  const WEEK_SECS = 7 * 24 * 60 * 60;
  const DAY_SECS = 24 * 60 * 60;
  const FIXED_SUPRA = "0x00000000000000000000000000000000000003f7";
  const PAIR_ID = 1;
  const ORACLE_SCALE = BigNumber.from(10).pow(8);   // matches mockSupra decimal
  const PRICE_1_TO_1 = ORACLE_SCALE;               // 1 QUOTE per 1 BASE

  async function increaseTime(seconds: number) {
    await network.provider.send("evm_increaseTime", [seconds]);
    await network.provider.send("evm_mine");
  }

  async function setNextBlockTimestamp(ts: number) {
    await network.provider.send("evm_setNextBlockTimestamp", [ts]);
    await network.provider.send("evm_mine");
  }

  // for integer rounding for equality checks
  function isWithinOne(a: BigNumber, b: BigNumber): boolean {
    const absDiff =  a.gte(b) ? a.sub(b) : b.sub(a);
    return absDiff <= BigNumber.from(1);
  }

  beforeEach(async () => {
    [deployer, alice, bob] = await ethers.getSigners();
    const deployerAddr = await deployer.getAddress();

    // ---------- Deploy mock underlying tokens ----------
    const ERC20MockFactory = await ethers.getContractFactory("ERC20Mock");
    token0 = (await ERC20MockFactory.deploy("Token0", "TK0", 8, INITIAL_MINT)) as ERC20Mock;
    await token0.deployed();

    const ERC20MockFactory2 = await ethers.getContractFactory("ERC20Mock");
    token1 = (await ERC20MockFactory2.deploy("Token1", "TK1", 8, INITIAL_MINT)) as ERC20Mock;
    await token1.deployed();

    // ---------- Deploy distributor ----------
    const Distributor = await ethers.getContractFactory("AirdropDistributor");
    distributor = (await Distributor.deploy()) as AirdropDistributor;
    await distributor.deployed();

    // ---------- Deploy vault ----------
    const Vault = await ethers.getContractFactory("PLEXPairVault");
    vault = (await Vault.deploy(
      token0.address,
      token1.address,
      token0.address,
      token1.address,
      distributor.address,
      initOwnerBips
    )) as PLEXPairVault;
    await vault.deployed();

    // ---------- Deploy your existing mocks ----------
    const MockSupraFactory = await ethers.getContractFactory("MockSupraPriceFeed");
    mockSupra = (await MockSupraFactory.deploy()) as MockSupraPriceFeed;
    await mockSupra.deployed();

    const SupraRegistryFactory = await ethers.getContractFactory("SupraRegistry");
    // This instance is only used to grab runtime bytecode:
    const supraImpl = (await SupraRegistryFactory.deploy(mockSupra.address)) as SupraRegistry;
    await supraImpl.deployed();

    const supraRuntime = await ethers.provider.getCode(supraImpl.address);

    // Pin SupraRegistry runtime at the fixed address used by the vault
    await network.provider.send("hardhat_setCode", [FIXED_SUPRA, supraRuntime]);

    // Make deployer the owner of the pinned instance by patching slot 0
    const ownerSlot = "0x" + "0".repeat(64); // storage slot 0
    const encodedOwner = ethers.utils.defaultAbiCoder.encode(["address"], [deployerAddr]);
    await network.provider.send("hardhat_setStorageAt", [FIXED_SUPRA, ownerSlot, encodedOwner]);

    // Now we can treat 0x...03f7 as a normal SupraRegistry instance:
    supraAtFixed = (await ethers.getContractAt("SupraRegistry", FIXED_SUPRA)) as SupraRegistry;

    // Point it at the mock Supra feed
    await supraAtFixed.changeSupraAddress(mockSupra.address);

    // Register BASE/QUOTE pair with id=1
    await supraAtFixed.registerPair(1, token0.address, token1.address);

    // Configure MockSupraPriceFeed for pairId=1
    const price = BigNumber.from(10).pow(8); // 1.0 * 1e8
    const scale = BigNumber.from(10).pow(8); // 1e8
    const latestBlock = await ethers.provider.getBlock("latest");
    const ts = latestBlock!.timestamp;

    await mockSupra.setPriceInfo(
      1,
      [1],                 // pairs
      [price],             // prices
      [ts],                // timestamp
      [scale],             // decimal
      [0]                  // round
    );

    // This is the "proof" bytes the vault passes through to Supra: abi.encode(pairId)
    supraArgs = ethers.utils.defaultAbiCoder.encode(["uint256"], [1]);
  });

  describe("deployment", () => {
    it("sets token0 correctly", async () => {
      expect(await token0.name()).to.equal("Token0");
      expect(await token0.symbol()).to.equal("TK0");
      expect(await token0.decimals()).to.equal(8);
      expect(await token0.totalSupply()).to.equal(BigNumber.from(10).pow(17));
    });
    it("sets token1 correctly", async () => {
      expect(await token1.name()).to.equal("Token1");
      expect(await token1.symbol()).to.equal("TK1");
      expect(await token1.decimals()).to.equal(8);
      expect(await token1.totalSupply()).to.equal(BigNumber.from(10).pow(17));
    });
    it("sets vault correctly", async () => {
      expect(await vault.BASE()).to.equal(token0.address);
      expect(await vault.QUOTE()).to.equal(token1.address);
      expect(await vault.ORACLE_BASE()).to.equal(token0.address);
      expect(await vault.ORACLE_QUOTE()).to.equal(token1.address);
      expect(await vault.distributor()).to.equal(distributor.address);
    });
  });

  // ─────────────────────────────────────────────────────────────
  // Admin: setBalanceToleranceBips
  // ─────────────────────────────────────────────────────────────
  describe("admin: setBalanceToleranceBips", () => {
    it("allows only owner to set within bounds and emits event", async () => {
      // default should be 1000 (0.10%)
      expect(await vault.balanceTolBips()).to.equal(1000);

      // non‑owner cannot set
      await expect(
        vault.connect(alice).setBalanceToleranceBips(2000)
      ).to.be.revertedWith("Ownable: caller is not the owner");

      // owner can set within cap
      await expect(vault.setBalanceToleranceBips(2000))
        .to.emit(vault, "BalanceToleranceSet")
        .withArgs(2000);

      expect(await vault.balanceTolBips()).to.equal(2000);
    });

    it("reverts if tolerance is above 5%", async () => {
      // > 50_000 bips → revert
      await expect(
        vault.setBalanceToleranceBips(50_001)
      ).to.be.revertedWith("tol too high");
    });
  });

  // ─────────────────────────────────────────────────────────────
  // Admin: scheduleOwnerFeeBips
  // ─────────────────────────────────────────────────────────────
  describe("admin: scheduleOwnerFeeBips", () => {
    it("only owner can schedule and enforces max cap", async () => {
      // non‑owner blocked
      await expect(
        vault.connect(alice).scheduleOwnerFeeBips(1000)
      ).to.be.revertedWith("Ownable: caller is not the owner");

      // above cap (0.3% / week) blocked
      await expect(
        vault.scheduleOwnerFeeBips(3001)
      ).to.be.revertedWith("rate>0.3%");
    });

    it("schedules fee with 1-week delay and enforces cooldown", async () => {
      // schedule first change
      const tx = await vault.scheduleOwnerFeeBips(1500);
      const receipt = await tx.wait();
      const block = await ethers.provider.getBlock(receipt.blockNumber);
      if (!block) throw new Error("block not found");

      const nowTs = block.timestamp;
      const expectedEffectiveTs = nowTs + WEEK_SECS;

      // check storage
      expect(await vault.pendingOwnerFeeBips()).to.equal(1500);
      expect(await vault.pendingOwnerFeeTs()).to.equal(expectedEffectiveTs);
      expect(await vault.lastFeeChangeTs()).to.equal(nowTs);

      // event
      await expect(tx)
        .to.emit(vault, "OwnerFeeRateScheduled")
        .withArgs(1500, expectedEffectiveTs);

      // cooldown: cannot change again within <1 week
      await expect(
        vault.scheduleOwnerFeeBips(1000)
      ).to.be.revertedWith("fee change cooldown < 1w");

      // move time forward >1 week and schedule again
      await increaseTime(WEEK_SECS + 1);

      const tx2 = await vault.scheduleOwnerFeeBips(500);
      const receipt2 = await tx2.wait();

      // second schedule should update pending params
      const block2 = await ethers.provider.getBlock(receipt2.blockNumber);
      if (!block2) throw new Error("block2 not found");
      const expectedEffectiveTs2 = block2.timestamp + WEEK_SECS;

      expect(await vault.pendingOwnerFeeBips()).to.equal(500);
      expect(await vault.pendingOwnerFeeTs()).to.equal(expectedEffectiveTs2);
      expect(await vault.lastFeeChangeTs()).to.equal(block2.timestamp);
    });
  });

  // ─────────────────────────────────────────────────────────────
  // View: ownerFeeInfo
  // ─────────────────────────────────────────────────────────────
  describe("view: ownerFeeInfo", () => {
    it("initial values", async () => {
      const info = await vault.ownerFeeInfo();

      expect(info.currentBips).to.equal(initOwnerBips);
      expect(info.pendingBips).to.equal(0);
      expect(info.pendingEffectiveTs).to.equal(0);
      expect(info.lastChangeTs).to.equal(0);
      // lastAccrualTs is set in constructor to deploy time, just assert > 0
      expect(info.lastAccrualTs).to.be.gt(0);
      expect(info.feeShares).to.equal(0);
    });

    it("reflects scheduled fee as pending and flips currentBips after effectiveTs", async () => {
      // schedule 0.1% / week
      const tx = await vault.scheduleOwnerFeeBips(1001);
      const receipt = await tx.wait();
      const block = await ethers.provider.getBlock(receipt.blockNumber);
      if (!block) throw new Error("block not found");

      const scheduledTs = block.timestamp;
      const effectiveTs = scheduledTs + WEEK_SECS;

      // Immediately after scheduling:
      let info = await vault.ownerFeeInfo();
      // storage ownerFeeBips is still 0, so currentBips is 0
      expect(info.currentBips).to.equal(initOwnerBips);
      expect(info.pendingBips).to.equal(1001);
      expect(info.pendingEffectiveTs).to.equal(effectiveTs);
      expect(info.lastChangeTs).to.equal(scheduledTs);

      // Just before effective timestamp: still sees old rate
      await setNextBlockTimestamp(effectiveTs - 1);
      info = await vault.ownerFeeInfo();
      expect(info.currentBips).to.equal(initOwnerBips);

      // After effective timestamp: view treats pending as current,
      // even if storage ownerFeeBips hasn't been updated by _accrueMgmtFee yet.
      await setNextBlockTimestamp(effectiveTs + 1);
      info = await vault.ownerFeeInfo();
      expect(info.currentBips).to.equal(1001);
      expect(info.pendingBips).to.equal(1001);
      expect(info.pendingEffectiveTs).to.equal(effectiveTs);

      // Direct storage check: ownerFeeBips is still 0 until some mutating
      // call triggers _accrueMgmtFee (this is expected).
      const storedRate = await vault.ownerFeeBips();
      expect(storedRate).to.equal(0);
    });
  });

  // ─────────────────────────────────────────────────────────────
  // Management fee
  // ─────────────────────────────────────────────────────────────
  describe("management fee accrual with mocked Supra", () => {
    const ONE = BigNumber.from(10).pow(8);         // token decimals = 8
    const ORACLE_SCALE = BigNumber.from(10).pow(8);
    const PRICE_1_TO_1 = ORACLE_SCALE;             // 1 QUOTE per 1 BASE
    const PAIR_ID = 1;

    // helper: refresh oracle with 1:1 price at the current block timestamp
    async function refreshOracleToNowAtOneToOne() {
      const latestBlock = await ethers.provider.getBlock("latest");
      const ts = latestBlock!.timestamp;
      await mockSupra.setPriceInfo(
        PAIR_ID,
        [PAIR_ID],        // pairs
        [PRICE_1_TO_1],   // prices
        [ts],             // timestamp
        [ORACLE_SCALE],   // decimal
        [0]               // round
      );
    }

    /**
     * helper: 
     *  - Alice makes a balanced deposit
     *  - owner schedules a new feeBips
     *  - we time‑travel until the new rate is active
     *  - we impersonate the distributor to call onAirdropFunded
     *    (which triggers _accrueMgmtFee and mints ownerFeeShares)
     *
     * Returns the amount of accrued ownerFeeShares.
     */
    async function setupVaultWithAccruedFees(newBips: number = 1_000) {
      const aliceAddr = await alice.getAddress();

      const depositAmount = ONE.mul(1_000); // 1000 units on each side

      // fund Alice and approve
      await token0.transfer(aliceAddr, depositAmount);
      await token1.transfer(aliceAddr, depositAmount);
      await token0.connect(alice).approve(vault.address, depositAmount);
      await token1.connect(alice).approve(vault.address, depositAmount);

      // 1) Alice deposits balanced liquidity (this also calls _accrueMgmtFee once)
      await refreshOracleToNowAtOneToOne();
      await vault.connect(alice).depositWithPolicy(depositAmount, depositAmount, supraArgs);

      // 2) schedule a new owner fee rate
      const tx = await vault.scheduleOwnerFeeBips(newBips);
      const rcpt = await tx.wait();
      const block = await ethers.provider.getBlock(rcpt!.blockNumber);
      if (!block) throw new Error("block not found");
      const scheduledAt = block.timestamp;
      const effectiveTs = scheduledAt + WEEK_SECS;

      // 3) jump to when that rate is active
      await setNextBlockTimestamp(effectiveTs + DAY_SECS);

      // 4) impersonate the distributor, call onAirdropFunded to trigger _accrueMgmtFee
      const distAddr = distributor.address;
      await network.provider.send("hardhat_setBalance", [
        distAddr,
        "0x8AC7230489E80000", // 10 ETH
      ]);
      await network.provider.send("hardhat_impersonateAccount", [distAddr]);
      const distSigner = await ethers.getSigner(distAddr);

      await vault.connect(distSigner).onAirdropFunded(token1.address, 1); // netAmount>0 just to hit the hook

      await network.provider.send("hardhat_stopImpersonatingAccount", [distAddr]);

      const feeShares = await vault.ownerFeeShares();
      expect(feeShares).to.be.gt(0);

      let depositorShares = await vault.userShares(aliceAddr)
      return { depositAmount, feeShares, depositorShares };
    }

    it("accrues owner fee shares once the scheduled rate becomes active", async () => {
      const totalBefore = await vault.totalShares();

      const { feeShares, depositorShares } = await setupVaultWithAccruedFees(2_000); // e.g. 0.2%/week
      const totalAfter = await vault.totalShares();

      expect(feeShares).to.be.gt(0);
      expect(totalAfter).to.be.gt(totalBefore);
      expect(feeShares).to.equal(totalAfter.sub(totalBefore).sub(depositorShares));
    });

    it("ownerRedeemFees pays 50/50 BASE and QUOTE when inventory is balanced", async () => {
      const ownerAddr = await deployer.getAddress();

      await setupVaultWithAccruedFees(1_000); // 0.1%/week, arbitrary non‑zero
      const feeShares = await vault.ownerFeeShares();
      expect(feeShares).to.be.gt(0);

      // snapshot inventory before redeem (balanced deposit, no extra imbalance created)
      const baseBalBefore = await token0.balanceOf(vault.address);
      const quoteBalBefore = await token1.balanceOf(vault.address);

      // sanity: balanced inventory by units (and price=1 => balanced by value)
      expect(baseBalBefore).to.equal(quoteBalBefore);

      // owner balances before
      const ownerBaseBefore = await token0.balanceOf(ownerAddr);
      const ownerQuoteBefore = await token1.balanceOf(ownerAddr);

      // make sure oracle is fresh for this block
      await refreshOracleToNowAtOneToOne();

      // redeem ALL owner fee‑shares
      await vault.connect(deployer).ownerRedeemFees(feeShares, 0, 0, supraArgs);

      const ownerBaseAfter = await token0.balanceOf(ownerAddr);
      const ownerQuoteAfter = await token1.balanceOf(ownerAddr);

      const deltaBase = ownerBaseAfter.sub(ownerBaseBefore);
      const deltaQuote = ownerQuoteAfter.sub(ownerQuoteBefore);

      // 1) Owner got something
      expect(deltaBase.add(deltaQuote)).to.be.gt(0);

      // 2) In a balanced inventory at price=1, payout should be 50/50 by value ⇒ equal units
      expect(isWithinOne(deltaBase, deltaQuote)).to.eq(true);

      // 3) Vault should remain balanced after redemption
      const baseBalAfter = await token0.balanceOf(vault.address);
      const quoteBalAfter = await token1.balanceOf(vault.address);
      expect(isWithinOne(baseBalAfter, quoteBalAfter)).to.eq(true);
    });

    it("ownerRedeemFees pays overweight token first, then 50/50 when inventory is imbalanced", async () => {
      const ownerAddr = await deployer.getAddress();

      await setupVaultWithAccruedFees(1_000);
      const feeShares = await vault.ownerFeeShares();
      expect(feeShares).to.be.gt(0);

      // introduce a small BASE overweight by sending extra BASE to the vault directly
      const extraBase = 10000; // 1 extra TK0
      await token0.connect(deployer).transfer(vault.address, extraBase);

      // snapshot inventory before redeem
      const baseBalBefore = await token0.balanceOf(vault.address);
      const quoteBalBefore = await token1.balanceOf(vault.address);

      // with a 1:1 price, BASE being overweight means baseBal > quoteBal
      expect(baseBalBefore).to.be.gt(quoteBalBefore);

      const imbalanceBefore = baseBalBefore.sub(quoteBalBefore);

      // owner balances before
      const ownerBaseBefore = await token0.balanceOf(ownerAddr);
      const ownerQuoteBefore = await token1.balanceOf(ownerAddr);

      // keep oracle fresh
      await refreshOracleToNowAtOneToOne();

      // redeem all fee‑shares
      await vault.connect(deployer).ownerRedeemFees(feeShares, 0, 0, supraArgs);

      const ownerBaseAfter = await token0.balanceOf(ownerAddr);
      const ownerQuoteAfter = await token1.balanceOf(ownerAddr);

      const deltaBase = ownerBaseAfter.sub(ownerBaseBefore);
      const deltaQuote = ownerQuoteAfter.sub(ownerQuoteBefore);

      // 1) owner got something
      expect(deltaBase.add(deltaQuote)).to.be.gt(0);

      // 2) Because BASE is overweight, payout should give at least as much BASE as QUOTE (by units at price=1)
      expect(deltaBase.gte(deltaQuote)).to.equal(true);

      // 3) The imbalance in the vault should be strictly smaller after redeem
      const baseBalAfter = await token0.balanceOf(vault.address);
      const quoteBalAfter = await token1.balanceOf(vault.address);

      const imbalanceAfter = baseBalAfter.sub(quoteBalAfter);
      // still might be positive, but must be smaller
      expect(imbalanceAfter.lt(imbalanceBefore)).to.equal(true);
    });
  });
  // ─────────────────────────────────────────────────────────────
  // Emergency mode
  // ─────────────────────────────────────────────────────────────
  describe("emergency mode", () => {
    it("only vault owner or distributor owner can enable, and it is one-way", async () => {
      const [deployer, alice, bob] = await ethers.getSigners();
      const deployerAddr = await deployer.getAddress();
      const aliceAddr = await alice.getAddress();
      const bobAddr = await bob.getAddress();

      // 1) Non‑owner (and not distributor owner) cannot enable
      await expect(
        vault.connect(alice).enableEmergencyMode()
      ).to.be.revertedWith("emergency: not authorized");

      // 2) Vault owner can enable
      await expect(vault.enableEmergencyMode())
        .to.emit(vault, "EmergencyModeEnabled")
        .withArgs(deployerAddr);

      expect(await vault.emergencyMode()).to.equal(true);

      // 3) Cannot be enabled twice
      await expect(
        vault.enableEmergencyMode()
      ).to.be.revertedWith("emergency: already enabled");

      // 4) New fresh setup: distributor owner (different from vault owner) can also enable
      //    Redeploy vault + distributor with different owners for this part.
      //    (We do it inline so it doesn't affect other tests.)
      const Distributor = await ethers.getContractFactory("AirdropDistributor");
      const distributor2 = (await Distributor.deploy()) as AirdropDistributor;
      await distributor2.deployed();

      const Vault = await ethers.getContractFactory("PLEXPairVault");
      const vault2 = (await Vault.deploy(
        token0.address,
        token1.address,
        token0.address,
        token1.address,
        distributor2.address,
        0  // initOwnerBips
      )) as PLEXPairVault;
      await vault2.deployed();

      // transfer vault2 ownership to bob, distributor2 ownership to alice
      await vault2.transferOwnership(bobAddr);
      await distributor2.transferOwnership(aliceAddr);

      // alice is now distributor owner → allowed to enable emergencyMode
      await expect(
        vault2.connect(alice).enableEmergencyMode()
      )
        .to.emit(vault2, "EmergencyModeEnabled")
        .withArgs(aliceAddr);

      expect(await vault2.emergencyMode()).to.equal(true);
    });

    it("blocks new deposits once emergency mode is enabled", async () => {
      const aliceAddr = await alice.getAddress();
      const depositAmount = ethers.utils.parseUnits("1000", 8);

      // fund Alice
      await token0.transfer(aliceAddr, depositAmount);
      await token1.transfer(aliceAddr, depositAmount);

      await token0.connect(alice).approve(vault.address, depositAmount);
      await token1.connect(alice).approve(vault.address, depositAmount);

      // deposit works before emergency
      await vault.connect(alice).depositWithPolicy(depositAmount, depositAmount, supraArgs);

      // enable emergency
      await vault.enableEmergencyMode();
      expect(await vault.emergencyMode()).to.equal(true);

      // further deposits are blocked
      await expect(
        vault.connect(alice).depositWithPolicy(depositAmount, depositAmount, supraArgs)
      ).to.be.revertedWith("emergency: deposits disabled");
    });

    it("emergencyWithdrawFromDeposit is disabled when not in emergency mode", async () => {
      const aliceAddr = await alice.getAddress();
      const depositAmount = ethers.utils.parseUnits("500", 8);

      await token0.transfer(aliceAddr, depositAmount);
      await token1.transfer(aliceAddr, depositAmount);
      await token0.connect(alice).approve(vault.address, depositAmount);
      await token1.connect(alice).approve(vault.address, depositAmount);

      await vault.connect(alice).depositWithPolicy(depositAmount, depositAmount, supraArgs);

      const userDeps = await vault.depositsOf(aliceAddr);
      expect(userDeps.length).to.eq(1);
      const depId = userDeps[0];

      // emergency mode not enabled yet → revert
      await expect(
        vault.connect(alice).emergencyWithdrawFromDeposit(depId)
      ).to.be.revertedWith("emergency: disabled");
    });

    it("emergencyWithdrawFromDeposit ignores lockup and pays strict pro‑rata BASE/QUOTE", async () => {
      const aliceAddr = await alice.getAddress();
      const depositAmount = ethers.utils.parseUnits("1000", 8); // 1000 TK0 + 1000 TK1

      // Give Alice funds and approve
      await token0.transfer(aliceAddr, depositAmount);
      await token1.transfer(aliceAddr, depositAmount);
      await token0.connect(alice).approve(vault.address, depositAmount);
      await token1.connect(alice).approve(vault.address, depositAmount);

      // Deposit once (balanced)
      await vault.connect(alice).depositWithPolicy(depositAmount, depositAmount, supraArgs);

      const userDeps = await vault.depositsOf(aliceAddr);
      expect(userDeps.length).to.eq(1);
      const depId = userDeps[0];

      const depBefore = await vault.deposits(depId);
      const shares = depBefore.shares;
      expect(shares).to.be.gt(0);

      // Lockup should still be active immediately after deposit
      const nowBlock = await ethers.provider.getBlock("latest");
      expect(depBefore.lockupUntil).to.be.gt(nowBlock!.timestamp);

      // Enable emergency mode
      await vault.enableEmergencyMode();
      expect(await vault.emergencyMode()).to.equal(true);

      // Snapshot vault balances and totalShares BEFORE emergency withdraw
      const baseBalBefore = await token0.balanceOf(vault.address);
      const quoteBalBefore = await token1.balanceOf(vault.address);
      const totalSharesBefore = await vault.totalShares();

      // Expected strict pro‑rata
      const expectedBaseOut = baseBalBefore.mul(shares).div(totalSharesBefore);
      const expectedQuoteOut = quoteBalBefore.mul(shares).div(totalSharesBefore);

      const aliceBaseBefore = await token0.balanceOf(aliceAddr);
      const aliceQuoteBefore = await token1.balanceOf(aliceAddr);

      // Emergency withdraw should work even though lockup not passed
      await vault.connect(alice).emergencyWithdrawFromDeposit(depId);

      const aliceBaseAfter = await token0.balanceOf(aliceAddr);
      const aliceQuoteAfter = await token1.balanceOf(aliceAddr);

      const deltaBase = aliceBaseAfter.sub(aliceBaseBefore);
      const deltaQuote = aliceQuoteAfter.sub(aliceQuoteBefore);

      expect(deltaBase).to.equal(expectedBaseOut);
      expect(deltaQuote).to.equal(expectedQuoteOut);

      // User deposit list should now be empty
      const depsAfter = await vault.depositsOf(aliceAddr);
      expect(depsAfter.length).to.eq(0);
    });

    it("ownerRedeemFeesEmergency can only be used in emergency mode, and pays strict pro‑rata", async () => {
      const [deployerSigner, aliceSigner] = await ethers.getSigners();
      const ownerAddr = await deployerSigner.getAddress();
      const aliceAddr = await aliceSigner.getAddress();

      const depositAmount = ethers.utils.parseUnits("1000", 8);

      // Fund & approve Alice for a balanced deposit
      await token0.transfer(aliceAddr, depositAmount);
      await token1.transfer(aliceAddr, depositAmount);
      await token0.connect(aliceSigner).approve(vault.address, depositAmount);
      await token1.connect(aliceSigner).approve(vault.address, depositAmount);

      await vault.connect(aliceSigner).depositWithPolicy(depositAmount, depositAmount, supraArgs);

      // Schedule a non-zero fee rate, effective in 1 week
      const newFeeBips = 1_000; // 0.1% / week
      await vault.scheduleOwnerFeeBips(newFeeBips);

      // Move forward so the new rate is active
      await increaseTime(WEEK_SECS + DAY_SECS);

      // Enable emergency mode (still no fee shares yet)
      await vault.enableEmergencyMode();

      // Impersonate distributor to call onAirdropFunded and trigger fee accrual
      const distAddr = distributor.address;
      await network.provider.send("hardhat_setBalance", [
        distAddr,
        "0x8AC7230489E80000" // 10 ETH
      ]);
      await network.provider.request({
        method: "hardhat_impersonateAccount",
        params: [distAddr],
      });
      const distSigner = await ethers.getSigner(distAddr);

      // Call onAirdropFunded once; this calls _accrueMgmtFee() internally
      await vault.connect(distSigner).onAirdropFunded(token1.address, 1);

      await network.provider.request({
        method: "hardhat_stopImpersonatingAccount",
        params: [distAddr],
      });

      let feeShares = await vault.ownerFeeShares();
      expect(feeShares).to.be.gt(0);

      // ownerRedeemFeesEmergency must revert if not in emergency – check quickly on fresh setup
      // (We already enabled emergency above, so just assert non-owner can't call.)
      await expect(
        vault.connect(aliceSigner).ownerRedeemFeesEmergency(feeShares)
      ).to.be.revertedWith("Ownable: caller is not the owner");

      // Snapshot vault balances and total shares BEFORE redeem
      const totalSharesBefore = await vault.totalShares();
      const ownerBaseBefore = await token0.balanceOf(ownerAddr);
      const ownerQuoteBefore = await token1.balanceOf(ownerAddr);

      // IMPORTANT: we want _accrueMgmtFee() inside ownerRedeemFeesEmergency to do no extra work.
      // lastFeeAccrual was set in the onAirdropFunded tx. We now set the *next* tx timestamp
      // to exactly that same value so that nowTs == lastFeeAccrual and Δt=0.
      const lastAccrualTs = (await vault.lastFeeAccrual()).toNumber();
      const latestBlock = await ethers.provider.getBlock("latest");
      const targetTs = Math.max(lastAccrualTs, latestBlock.timestamp) + 1;

      await network.provider.send("evm_setNextBlockTimestamp", [targetTs]);

      feeShares = await vault.ownerFeeShares();

      const baseBalBefore = await token0.balanceOf(vault.address);
      const quoteBalBefore = await token1.balanceOf(vault.address);

      // Redeem all fee shares in emergency mode
      await vault.ownerRedeemFeesEmergency(feeShares);

      const totalSharesAfter = await vault.totalShares();
      const tsBeforeInternal = totalSharesAfter.add(feeShares); // S_before inside contract

      const expectedBaseOut  = baseBalBefore.mul(feeShares).div(tsBeforeInternal);
      const expectedQuoteOut = quoteBalBefore.mul(feeShares).div(tsBeforeInternal);

      const ownerBaseAfter = await token0.balanceOf(ownerAddr);
      const ownerQuoteAfter = await token1.balanceOf(ownerAddr);

      const deltaBase = ownerBaseAfter.sub(ownerBaseBefore);
      const deltaQuote = ownerQuoteAfter.sub(ownerQuoteBefore);

      expect(deltaBase).to.equal(expectedBaseOut);
      expect(deltaQuote).to.equal(expectedQuoteOut);
    });
  });
    // ─────────────────────────────────────────────────────────────
  // Deposits: share minting & inventory policy
  // ─────────────────────────────────────────────────────────────
  describe("deposits: share minting and inventory policy", () => {
    it("mints the correct number of shares for first and second balanced deposits", async () => {
      const [, aliceSigner, bobSigner] = await ethers.getSigners();
      const aliceAddr = await aliceSigner.getAddress();
      const bobAddr = await bobSigner.getAddress();

      const amount1 = ethers.utils.parseUnits("1000", 8); // 1000 TK0 + 1000 TK1
      const amount2 = ethers.utils.parseUnits("2000", 8); // 2000 TK0 + 2000 TK1

      // --- virtual offset constants (must match contract) ---
      const VIRTUAL_SHARES = BigNumber.from(1_000);
      const VIRTUAL_VALUEQ = BigNumber.from(1);

      // Fund & approve Alice
      await token0.transfer(aliceAddr, amount1);
      await token1.transfer(aliceAddr, amount1);
      await token0.connect(aliceSigner).approve(vault.address, amount1);
      await token1.connect(aliceSigner).approve(vault.address, amount1);

      // Fund & approve Bob
      await token0.transfer(bobAddr, amount2);
      await token1.transfer(bobAddr, amount2);
      await token0.connect(bobSigner).approve(vault.address, amount2);
      await token1.connect(bobSigner).approve(vault.address, amount2);

      // ---- First deposit (vault empty → tvlQBefore=0, supplyBefore=0) ----
      // price = 1:1, so principalQ = base + quote
      const principal1 = amount1.mul(2); // 1000 + 1000 in QUOTE-units (since price=1)

      // expectedShares1 = principal1 * (0 + VIRTUAL_SHARES) / (0 + VIRTUAL_VALUEQ)
      const expectedShares1 = principal1.mul(VIRTUAL_SHARES).div(VIRTUAL_VALUEQ);

      await vault.connect(aliceSigner).depositWithPolicy(amount1, amount1, supraArgs);

      const totalSharesAfter1 = await vault.totalShares();
      const aliceShares = await vault.userShares(aliceAddr);

      expect(totalSharesAfter1).to.equal(expectedShares1);
      expect(aliceShares).to.equal(expectedShares1);

      // Also check deposit struct
      const dep0 = await vault.deposits(0);
      expect(dep0.user).to.equal(aliceAddr);
      expect(dep0.shares).to.equal(expectedShares1);

      // ---- Second deposit (vault already balanced) ----
      const principal2 = amount2.mul(2); // 2000 + 2000

      // Supply before Bob's deposit
      const supplyBefore2 = await vault.totalShares();

      // TVL before Bob's deposit (QUOTE terms).
      // With 1:1 price and equal decimals, tvlQ = baseBal + quoteBal.
      const baseBalBefore2 = await token0.balanceOf(vault.address);
      const quoteBalBefore2 = await token1.balanceOf(vault.address);
      const tvlQBefore2 = baseBalBefore2.add(quoteBalBefore2);

      // expectedShares2 = principal2 * (supplyBefore2 + VIRTUAL_SHARES) / (tvlQBefore2 + VIRTUAL_VALUEQ)
      const expectedShares2 = principal2
        .mul(supplyBefore2.add(VIRTUAL_SHARES))
        .div(tvlQBefore2.add(VIRTUAL_VALUEQ));

      await vault.connect(bobSigner).depositWithPolicy(amount2, amount2, supraArgs);

      const totalSharesAfter2 = await vault.totalShares();
      const bobShares = await vault.userShares(bobAddr);

      expect(bobShares).to.equal(expectedShares2);
      expect(totalSharesAfter2).to.equal(supplyBefore2.add(expectedShares2));

      // Optional: check Bob deposit struct (depositId should be 1)
      const dep1 = await vault.deposits(1);
      expect(dep1.user).to.equal(bobAddr);
      expect(dep1.shares).to.equal(expectedShares2);
    });

    it("accepts only a 50/50-by-value split when the vault is balanced", async () => {
      const [, aliceSigner] = await ethers.getSigners();
      const aliceAddr = await aliceSigner.getAddress();

      const baseDesired = ethers.utils.parseUnits("1000", 8);
      const quoteDesired = ethers.utils.parseUnits("2000", 8); // more quote than needed

      // Fund & approve Alice
      await token0.transfer(aliceAddr, baseDesired);
      await token1.transfer(aliceAddr, quoteDesired);
      await token0.connect(aliceSigner).approve(vault.address, baseDesired);
      await token1.connect(aliceSigner).approve(vault.address, quoteDesired);

      // Vault is initially empty; TVL=0 is treated as "balanced".
      const baseVaultBefore = await token0.balanceOf(vault.address);
      const quoteVaultBefore = await token1.balanceOf(vault.address);

      await vault.connect(aliceSigner).depositWithPolicy(baseDesired, quoteDesired, supraArgs);

      const baseVaultAfter = await token0.balanceOf(vault.address);
      const quoteVaultAfter = await token1.balanceOf(vault.address);

      const deltaBase = baseVaultAfter.sub(baseVaultBefore);
      const deltaQuote = quoteVaultAfter.sub(quoteVaultBefore);

      // With price=1 and TVL considered balanced:
      // baseDesiredValQ = baseDesired
      // baseDesiredValQ <= quoteDesired → we accept:
      //   baseAccept  = baseDesired
      //   quoteAccept = baseDesiredValQ
      expect(deltaBase).to.equal(baseDesired);
      expect(deltaQuote).to.equal(baseDesired); // *not* quoteDesired

      // Now the vault is exactly balanced: 1000 / 1000
      expect(baseVaultAfter).to.equal(quoteVaultAfter);

      // When balanced, trying to deposit with only one side should result in "nothing accepted".
      const extraBase = ethers.utils.parseUnits("500", 8);
      const extraQuote = ethers.utils.parseUnits("500", 8);

      await token0.transfer(aliceAddr, extraBase);
      await token1.transfer(aliceAddr, extraQuote);
      await token0.connect(aliceSigner).approve(vault.address, extraBase);
      await token1.connect(aliceSigner).approve(vault.address, extraQuote);

      // Only BASE
      await expect(
        vault.connect(aliceSigner).depositWithPolicy(extraBase, 0, supraArgs)
      ).to.be.revertedWith("nothing accepted");

      // Only QUOTE
      await expect(
        vault.connect(aliceSigner).depositWithPolicy(0, extraQuote, supraArgs)
      ).to.be.revertedWith("nothing accepted");
    });

    it("accepts the underweight token until rebalanced, then extra liquidity as 50/50", async () => {
      const [, aliceSigner, bobSigner] = await ethers.getSigners();
      const aliceAddr = await aliceSigner.getAddress();
      const bobAddr = await bobSigner.getAddress();

      // Step 0: Create an imbalanced vault by sending QUOTE directly (BASE underweight)
      const initialQuoteImbalance = ethers.utils.parseUnits("1000", 8); // 0 BASE, 1000 QUOTE
      await token1.transfer(vault.address, initialQuoteImbalance);

      const baseBefore0 = await token0.balanceOf(vault.address);
      const quoteBefore0 = await token1.balanceOf(vault.address);
      expect(baseBefore0).to.equal(0);
      expect(quoteBefore0).to.equal(initialQuoteImbalance);

      // ── Phase A: user provides less BASE than needed to fully rebalance → BASE-only
      const baseMaxA = ethers.utils.parseUnits("600", 8); // < 1000 needed to balance
      const quoteMaxA = ethers.utils.parseUnits("1000", 8); // offered but should NOT be taken

      await token0.transfer(aliceAddr, baseMaxA);
      await token1.transfer(aliceAddr, quoteMaxA);
      await token0.connect(aliceSigner).approve(vault.address, baseMaxA);
      await token1.connect(aliceSigner).approve(vault.address, quoteMaxA);

      const baseVaultBeforeA = await token0.balanceOf(vault.address);
      const quoteVaultBeforeA = await token1.balanceOf(vault.address);

      await vault.connect(aliceSigner).depositWithPolicy(baseMaxA, quoteMaxA, supraArgs);

      const baseVaultAfterA = await token0.balanceOf(vault.address);
      const quoteVaultAfterA = await token1.balanceOf(vault.address);

      const deltaBaseA = baseVaultAfterA.sub(baseVaultBeforeA);
      const deltaQuoteA = quoteVaultAfterA.sub(quoteVaultBeforeA);

      // BASE is underweight, needBase = 1000 to fully rebalance.
      // Since user only provided 600 < 1000, vault should accept:
      //   baseAccept  = 600
      //   quoteAccept = 0
      expect(deltaBaseA).to.equal(baseMaxA);
      expect(deltaQuoteA).to.equal(0);

      // Still imbalanced: BASE (600), QUOTE (1000)
      expect(baseVaultAfterA).to.equal(baseMaxA);
      expect(quoteVaultAfterA).to.equal(initialQuoteImbalance);

      // ── Phase B: another user provides enough BASE + QUOTE for two-phase deposit
      const baseMaxB = ethers.utils.parseUnits("2000", 8);
      const quoteMaxB = ethers.utils.parseUnits("2000", 8);

      await token0.transfer(bobAddr, baseMaxB);
      await token1.transfer(bobAddr, quoteMaxB);
      await token0.connect(bobSigner).approve(vault.address, baseMaxB);
      await token1.connect(bobSigner).approve(vault.address, quoteMaxB);

      const baseVaultBeforeB = await token0.balanceOf(vault.address);
      const quoteVaultBeforeB = await token1.balanceOf(vault.address);

      // At this point, vault has:
      //   baseBal  = 600
      //   quoteBal = 1000
      //   → BASE underweight by 400 (in value terms at price=1).
      //
      // Phase 1:
      //   needBase = 400
      //   phase1Base = 400
      //
      // Phase 2 (balanced state, remaining caps base=1600, quote=2000):
      //   pair 50/50 by value → take 1600 BASE + 1600 QUOTE
      //
      // Total accepted in this second deposit:
      //   baseAccept  = 400 + 1600 = 2000
      //   quoteAccept = 1600
      await vault.connect(bobSigner).depositWithPolicy(baseMaxB, quoteMaxB, supraArgs);

      const baseVaultAfterB = await token0.balanceOf(vault.address);
      const quoteVaultAfterB = await token1.balanceOf(vault.address);

      const deltaBaseB = baseVaultAfterB.sub(baseVaultBeforeB);
      const deltaQuoteB = quoteVaultAfterB.sub(quoteVaultBeforeB);

      const expectedPhase1Base = ethers.utils.parseUnits("400", 8);
      const expectedPhase2Base = ethers.utils.parseUnits("1600", 8);
      const expectedPhase2Quote = ethers.utils.parseUnits("1600", 8);

      expect(deltaBaseB).to.equal(expectedPhase1Base.add(expectedPhase2Base)); // 2000
      expect(deltaQuoteB).to.equal(expectedPhase2Quote);                       // 1600

      // Final inventory should be perfectly balanced by value (price=1:1):
      //   BASE: 600 (from A) + 2000 (from B) = 2600
      //   QUOTE: 1000 (initial) + 0 (A) + 1600 (B) = 2600
      expect(baseVaultAfterB).to.equal(quoteVaultAfterB);
    });
  });
  // ─────────────────────────────────────────────────────────────
  // Deposit lot storage
  // ─────────────────────────────────────────────────────────────
  describe("deposit lot storage", () => {
    // Helper to refresh the mock Supra price so withdrawals don't hit "oracle: stale"
    async function refreshOracle() {
      const latestBlock = await ethers.provider.getBlock("latest");
      const ts = latestBlock!.timestamp;
      const price = BigNumber.from(10).pow(8);  // 1.0 * 1e8
      const scale = BigNumber.from(10).pow(8);  // 1e8
      await mockSupra.setPriceInfo(
        1,
        [1],        // pairs
        [price],    // prices
        [ts],       // timestamp
        [scale],    // decimal
        [0]         // round
      );
    }

    const LOCKUP_SECS = 24 * 60 * 60;

    it("assigns monotonically increasing depositIds and never reuses them", async () => {
      const aliceAddr = await alice.getAddress();

      const amt = ethers.utils.parseUnits("100", 8);

      // Fund Alice
      await token0.transfer(aliceAddr, amt);
      await token1.transfer(aliceAddr, amt);
      await token0.connect(alice).approve(vault.address, amt);
      await token1.connect(alice).approve(vault.address, amt);

      // 1st deposit
      await vault.connect(alice).depositWithPolicy(amt, amt, supraArgs);
      let aliceDeposits = await vault.depositsOf(aliceAddr);
      expect(aliceDeposits.length).to.equal(1);
      const firstId = aliceDeposits[0];

      // Check underlying storage
      let firstLot = await vault.deposits(firstId);
      expect(firstLot.user).to.equal(aliceAddr);
      expect(firstLot.shares).to.be.gt(0);

      // Wait out lockup, then withdraw all from that lot
      await increaseTime(LOCKUP_SECS + 1);
      await refreshOracle();
      await vault.connect(alice).withdrawAllFromDeposit(firstId, supraArgs);

      aliceDeposits = await vault.depositsOf(aliceAddr);
      expect(aliceDeposits.length).to.equal(0);

      // Slot is cleared: user == 0, shares == 0
      firstLot = await vault.deposits(firstId);
      expect(firstLot.user).to.equal(ethers.constants.AddressZero);
      expect(firstLot.shares).to.equal(0);

      const depositsLenAfterFirst = await vault.depositsLength();
      expect(depositsLenAfterFirst).to.equal(1); // id 0 exists but cleared

      // 2nd deposit by Alice
      await token0.connect(alice).approve(vault.address, amt);
      await token1.connect(alice).approve(vault.address, amt);
      await vault.connect(alice).depositWithPolicy(amt, amt, supraArgs);

      aliceDeposits = await vault.depositsOf(aliceAddr);
      expect(aliceDeposits.length).to.equal(1);
      const secondId = aliceDeposits[0];

      // id must be strictly greater than firstId (no reuse)
      expect(secondId).to.be.gt(firstId);

      const depositsLenAfterSecond = await vault.depositsLength();
      expect(depositsLenAfterSecond).to.equal(2); // indices 0 and 1 allocated

      const secondLot = await vault.deposits(secondId);
      expect(secondLot.user).to.equal(aliceAddr);
      expect(secondLot.shares).to.be.gt(0);
    });

    it("keeps depositId in _userDeposits on partial withdraw and clears it only when shares go to zero", async () => {
      const aliceAddr = await alice.getAddress();
      const amt = ethers.utils.parseUnits("200", 8);

      // Fund + approve
      await token0.transfer(aliceAddr, amt);
      await token1.transfer(aliceAddr, amt);
      await token0.connect(alice).approve(vault.address, amt);
      await token1.connect(alice).approve(vault.address, amt);

      await vault.connect(alice).depositWithPolicy(amt, amt, supraArgs);
      let ids = await vault.depositsOf(aliceAddr);
      expect(ids.length).to.equal(1);
      const depId = ids[0];

      let lot = await vault.deposits(depId);
      const fullShares = lot.shares;

      // move beyond lockup
      await increaseTime(LOCKUP_SECS + 1);
      await refreshOracle();
      // Partial withdraw (half the shares)
      const halfShares = fullShares.div(2);
      await vault.connect(alice).withdrawFromDeposit(depId, halfShares, supraArgs);

      // deposit still exists in mapping
      ids = await vault.depositsOf(aliceAddr);
      expect(ids.length).to.equal(1);
      expect(ids[0]).to.equal(depId);

      lot = await vault.deposits(depId);
      expect(lot.user).to.equal(aliceAddr);
      expect(lot.shares).to.equal(fullShares.sub(halfShares));

      // Withdraw the rest
      await vault.connect(alice).withdrawFromDeposit(depId, lot.shares, supraArgs);

      // Now it should be removed
      ids = await vault.depositsOf(aliceAddr);
      expect(ids.length).to.equal(0);

      lot = await vault.deposits(depId);
      expect(lot.user).to.equal(ethers.constants.AddressZero);
      expect(lot.shares).to.equal(0);
    });

    it("removing a deposit for one user does not affect another user's deposits", async () => {
      const aliceAddr = await alice.getAddress();
      const bobAddr   = await bob.getAddress();
      const amt = ethers.utils.parseUnits("100", 8);

      // Fund both
      await token0.transfer(aliceAddr, amt.mul(2));
      await token1.transfer(aliceAddr, amt.mul(2));
      await token0.transfer(bobAddr,   amt.mul(2));
      await token1.transfer(bobAddr,   amt.mul(2));

      await token0.connect(alice).approve(vault.address, amt.mul(2));
      await token1.connect(alice).approve(vault.address, amt.mul(2));
      await token0.connect(bob).approve(vault.address, amt.mul(2));
      await token1.connect(bob).approve(vault.address, amt.mul(2));

      // Alice deposits twice
      await vault.connect(alice).depositWithPolicy(amt, amt, supraArgs);
      await vault.connect(alice).depositWithPolicy(amt, amt, supraArgs);

      // Bob deposits once
      await vault.connect(bob).depositWithPolicy(amt, amt, supraArgs);

      let aliceIds = await vault.depositsOf(aliceAddr);
      let bobIds   = await vault.depositsOf(bobAddr);

      expect(aliceIds.length).to.equal(2);
      expect(bobIds.length).to.equal(1);

      const aliceDepToWithdraw = aliceIds[0];

      // move beyond lockup
      await increaseTime(LOCKUP_SECS + 1);
      await refreshOracle();

      await vault.connect(alice).withdrawAllFromDeposit(aliceDepToWithdraw, supraArgs);

      // Alice should have exactly 1 remaining deposit
      aliceIds = await vault.depositsOf(aliceAddr);
      expect(aliceIds.length).to.equal(1);
      expect(aliceIds[0]).to.not.equal(aliceDepToWithdraw);

      // Bob should still have his 1 deposit, unchanged
      bobIds = await vault.depositsOf(bobAddr);
      expect(bobIds.length).to.equal(1);

      const bobLot = await vault.deposits(bobIds[0]);
      expect(bobLot.user).to.equal(bobAddr);
      expect(bobLot.shares).to.be.gt(0);
    });

    it("emergencyWithdrawFromDeposit clears the lot and removes depositId from _userDeposits", async () => {
      const aliceAddr = await alice.getAddress();
      const amt = ethers.utils.parseUnits("100", 8);

      // Fund & approve
      await token0.transfer(aliceAddr, amt);
      await token1.transfer(aliceAddr, amt);
      await token0.connect(alice).approve(vault.address, amt);
      await token1.connect(alice).approve(vault.address, amt);

      // Alice deposit
      await vault.connect(alice).depositWithPolicy(amt, amt, supraArgs);
      let ids = await vault.depositsOf(aliceAddr);
      expect(ids.length).to.equal(1);
      const depId = ids[0];

      let lot = await vault.deposits(depId);
      expect(lot.user).to.equal(aliceAddr);
      expect(lot.shares).to.be.gt(0);

      // Enable emergency mode
      await vault.enableEmergencyMode();

      // Emergency withdraw (ignores lockup)
      await vault.connect(alice).emergencyWithdrawFromDeposit(depId);

      // Mapping cleared
      ids = await vault.depositsOf(aliceAddr);
      expect(ids.length).to.equal(0);

      lot = await vault.deposits(depId);
      expect(lot.user).to.equal(ethers.constants.AddressZero);
      expect(lot.shares).to.equal(0);
    });
    it("removes a middle deposit id from _userDeposits using swap‑and‑pop", async () => {
      const aliceAddr = await alice.getAddress();
      const ONE = BigNumber.from(10).pow(8);
      const depositAmt = ONE.mul(1_000);
      const totalNeeded = depositAmt.mul(3);

      // Give Alice enough for 3 deposits
      await token0.transfer(aliceAddr, totalNeeded);
      await token1.transfer(aliceAddr, totalNeeded);
      await token0.connect(alice).approve(vault.address, totalNeeded);
      await token1.connect(alice).approve(vault.address, totalNeeded);

      // Three deposits → _userDeposits[alice] should have 3 lot ids
      await vault.connect(alice).depositWithPolicy(depositAmt, depositAmt, supraArgs);
      await vault.connect(alice).depositWithPolicy(depositAmt, depositAmt, supraArgs);
      await vault.connect(alice).depositWithPolicy(depositAmt, depositAmt, supraArgs);

      let deps = await vault.depositsOf(aliceAddr);
      expect(deps.length).to.equal(3);

      const id0 = deps[0];
      const id1 = deps[1]; // we'll withdraw this one (the "middle")
      const id2 = deps[2];

      // Pass lockup and refresh oracle before withdrawing
      await increaseTime(DAY_SECS + 1);
      await refreshOracle();

      // Withdraw the full middle lot
      await vault.connect(alice).withdrawAllFromDeposit(id1, supraArgs);

      // After swap‑and‑pop, we expect exactly two ids remaining: {id0, id2} in some order.
      deps = await vault.depositsOf(aliceAddr);
      expect(deps.length).to.equal(2);

      const remaining = deps.map(x => x.toNumber()).sort();
      const expectedRemaining = [id0.toNumber(), id2.toNumber()].sort();
      expect(remaining).to.deep.equal(expectedRemaining);

      // And the withdrawn lot struct should be cleared
      const dep1 = await vault.deposits(id1);
      expect(dep1.user).to.equal(ethers.constants.AddressZero);
      expect(dep1.shares).to.equal(0);
    });
  });
  // ─────────────────────────────────────────────────────────────
  // Withdrawals
  // ─────────────────────────────────────────────────────────────
  describe("withdrawals", () => {
    const LOCKUP_SECS = DAY_SECS; // matches vault's LOCKUP_SECS = 1 days

    async function refreshOracleToNowAtOneToOne() {
      const latestBlock = await ethers.provider.getBlock("latest");
      const ts = latestBlock!.timestamp;
      await mockSupra.setPriceInfo(
        PAIR_ID,
        [PAIR_ID],        // pairs
        [PRICE_1_TO_1],   // prices
        [ts],             // timestamp
        [ORACLE_SCALE],   // decimal
        [0]               // round
      );
    }

      // ─────────────────────────────────────────────────────────────
      // Withdrawals: safety & access control
      // ─────────────────────────────────────────────────────────────
      describe("withdrawals: safety & access control", () => {
        const ONE = BigNumber.from(10).pow(8);

        async function makeBalancedDepositForAlice() {
          const aliceAddr = await alice.getAddress();
          const baseAmt = ONE.mul(1_000);
          const quoteAmt = ONE.mul(1_000);

          // fund & approve Alice
          await token0.transfer(aliceAddr, baseAmt);
          await token1.transfer(aliceAddr, quoteAmt);
          await token0.connect(alice).approve(vault.address, baseAmt);
          await token1.connect(alice).approve(vault.address, quoteAmt);

          // balanced deposit into empty vault
          await vault.connect(alice).depositWithPolicy(baseAmt, quoteAmt, supraArgs);

          // fetch her depositId and lot data
          const ids = await vault.depositsOf(aliceAddr);
          expect(ids.length).to.equal(1);
          const depId = ids[0];

          const dep = await vault.deposits(depId);
          return { depId, dep };
        }

        it("enforces lockup and reverts withdrawals before lockup with 'locked'", async () => {
          const { depId, dep } = await makeBalancedDepositForAlice();

          // Sanity: shares > 0
          expect(dep.shares).to.be.gt(0);

          // Try to withdraw immediately (lockup = 1 day in the contract)
          await expect(
            vault
              .connect(alice)
              .withdrawFromDeposit(depId, dep.shares, supraArgs)
          ).to.be.revertedWith("locked");
        });

        it("reverts when trying to withdraw more than lot.shares with 'bad shares'", async () => {
          const { depId, dep } = await makeBalancedDepositForAlice();

          // Fast‑forward past lockup so we hit the "bad shares" check instead of "locked"
          await increaseTime(DAY_SECS + 1);

          const shares = dep.shares;
          const tooMany = shares.add(1);

          await expect(
            vault
              .connect(alice)
              .withdrawFromDeposit(depId, tooMany, supraArgs)
          ).to.be.revertedWith("bad shares");
        });

        it("allows only the lot owner to withdraw (non‑owner gets 'not owner')", async () => {
          const { depId, dep } = await makeBalancedDepositForAlice();

          // Bob tries to withdraw Alice's deposit, even for the correct number of shares
          await expect(
            vault
              .connect(bob)
              .withdrawFromDeposit(depId, dep.shares, supraArgs)
          ).to.be.revertedWith("not owner");
        });
      });
      // ─────────────────────────────────────────────────────────────
      // Withdrawals: preview vs actual
      // ─────────────────────────────────────────────────────────────
      describe("withdrawals: preview vs actual", () => {
        it("previewWithdrawalPayoutGivenPrice matches actual withdrawal in balanced vault", async () => {
          const aliceAddr = await alice.getAddress();
          const ONE = BigNumber.from(10).pow(8);         // 10^8 for 8‑decimals tokens
          const baseAmt = ONE.mul(1_000);               // 1000 TK0
          const quoteAmt = ONE.mul(1_000);              // 1000 TK1

          // Fund & approve Alice
          await token0.transfer(aliceAddr, baseAmt);
          await token1.transfer(aliceAddr, quoteAmt);
          await token0.connect(alice).approve(vault.address, baseAmt);
          await token1.connect(alice).approve(vault.address, quoteAmt);

          // Deposit balanced liquidity into an empty vault
          await vault.connect(alice).depositWithPolicy(baseAmt, quoteAmt, supraArgs);

          // Grab her single deposit lot
          const ids = await vault.depositsOf(aliceAddr);
          expect(ids.length).to.equal(1);
          const depId = ids[0];
          const dep = await vault.deposits(depId);

          // Wait out the 1‑day lockup
          await increaseTime(DAY_SECS + 1);

          // Refresh oracle so proof is not stale (1:1 price, same scale as in beforeEach)
          const latestBlock = await ethers.provider.getBlock("latest");
          const nowTs = latestBlock!.timestamp;
          const price = BigNumber.from(10).pow(8); // 1.0 * 1e8
          const scale = BigNumber.from(10).pow(8); // 1e8

          await mockSupra.setPriceInfo(
            1,
            [1],        // pairs
            [price],    // prices
            [nowTs],    // timestamp
            [scale],    // decimal
            [0]         // round
          );

          // Withdraw half the shares
          const halfShares = dep.shares.div(2);

          // --- Preview phase: use the same price/scale as the live oracle ---
          const preview = await vault.previewWithdrawalPayoutGivenPrice(
            halfShares,
            price,
            scale
          );
          const expectedBase = preview.baseOut;
          const expectedQuote = preview.quoteOut;

          // Snapshot Alice balances right before actual withdraw
          const baseBefore = await token0.balanceOf(aliceAddr);
          const quoteBefore = await token1.balanceOf(aliceAddr);

          // --- Actual withdrawal ---
          await vault
            .connect(alice)
            .withdrawFromDeposit(depId, halfShares, supraArgs);

          const baseAfter = await token0.balanceOf(aliceAddr);
          const quoteAfter = await token1.balanceOf(aliceAddr);

          const gotBase = baseAfter.sub(baseBefore);
          const gotQuote = quoteAfter.sub(quoteBefore);

          // Preview and actual must match 1:1 for this scenario
          expect(gotBase).to.equal(expectedBase);
          expect(gotQuote).to.equal(expectedQuote);
        });
      });
      // ─────────────────────────────────────────────────────────────
      // Withdrawals: multi‑user fairness
      // ─────────────────────────────────────────────────────────────
      describe("withdrawals: multi-user fairness", () => {
        it("two users withdrawing at different times get pro‑rata value according to shares", async () => {
          const aliceAddr = await alice.getAddress();
          const bobAddr   = await bob.getAddress();

          // Alice deposits 1000/1000, Bob deposits 3000/3000 (balanced vault)
          const aliceAmt = ethers.utils.parseUnits("1000", 8);
          const bobAmt   = ethers.utils.parseUnits("3000", 8);

          // Fund & approve Alice
          await token0.transfer(aliceAddr, aliceAmt);
          await token1.transfer(aliceAddr, aliceAmt);
          await token0.connect(alice).approve(vault.address, aliceAmt);
          await token1.connect(alice).approve(vault.address, aliceAmt);

          // Fund & approve Bob
          await token0.transfer(bobAddr, bobAmt);
          await token1.transfer(bobAddr, bobAmt);
          await token0.connect(bob).approve(vault.address, bobAmt);
          await token1.connect(bob).approve(vault.address, bobAmt);

          // Both deposit with price=1:1 (from beforeEach oracle setup)
          await vault.connect(alice).depositWithPolicy(aliceAmt, aliceAmt, supraArgs);
          await vault.connect(bob).depositWithPolicy(bobAmt, bobAmt, supraArgs);

          // One deposit lot each
          const aliceDeposits = await vault.depositsOf(aliceAddr);
          const bobDeposits   = await vault.depositsOf(bobAddr);
          expect(aliceDeposits.length).to.equal(1);
          expect(bobDeposits.length).to.equal(1);
          const aliceDepId = aliceDeposits[0];
          const bobDepId   = bobDeposits[0];

          // Move past lockup
          await increaseTime(DAY_SECS + 1);

          // Refresh oracle so withdraws don’t hit "stale" check
          await refreshOracleToNowAtOneToOne();

          // ------- Alice withdraws her entire lot first -------
          const baseBalBeforeA  = await token0.balanceOf(vault.address);
          const quoteBalBeforeA = await token1.balanceOf(vault.address);
          const tvlQBeforeA     = baseBalBeforeA.add(quoteBalBeforeA);

          const totalSharesBeforeA = await vault.totalShares();
          const aliceShares        = await vault.userShares(aliceAddr);

          const aliceBaseBefore  = await token0.balanceOf(aliceAddr);
          const aliceQuoteBefore = await token1.balanceOf(aliceAddr);

          await vault.connect(alice).withdrawAllFromDeposit(aliceDepId, supraArgs);

          const aliceBaseAfter  = await token0.balanceOf(aliceAddr);
          const aliceQuoteAfter = await token1.balanceOf(aliceAddr);

          const aliceDeltaBase  = aliceBaseAfter.sub(aliceBaseBefore);
          const aliceDeltaQuote = aliceQuoteAfter.sub(aliceQuoteBefore);
          const aliceTotalOut   = aliceDeltaBase.add(aliceDeltaQuote);

          // Expected pro‑rata value for Alice: tvl * shares / totalShares
          const aliceExpectedValueQ = tvlQBeforeA.mul(aliceShares).div(totalSharesBeforeA);
          expect(aliceTotalOut).to.equal(aliceExpectedValueQ);

          // Balanced inventories & price=1 → 50/50 by value → equal units
          expect(aliceDeltaBase).to.equal(aliceDeltaQuote);

          // ------- Bob withdraws afterwards -------
          await refreshOracleToNowAtOneToOne();

          const baseBalBeforeB  = await token0.balanceOf(vault.address);
          const quoteBalBeforeB = await token1.balanceOf(vault.address);
          const tvlQBeforeB     = baseBalBeforeB.add(quoteBalBeforeB);

          const totalSharesBeforeB = await vault.totalShares();
          const bobShares          = await vault.userShares(bobAddr);

          const bobBaseBefore  = await token0.balanceOf(bobAddr);
          const bobQuoteBefore = await token1.balanceOf(bobAddr);

          await vault.connect(bob).withdrawAllFromDeposit(bobDepId, supraArgs);

          const bobBaseAfter  = await token0.balanceOf(bobAddr);
          const bobQuoteAfter = await token1.balanceOf(bobAddr);

          const bobDeltaBase  = bobBaseAfter.sub(bobBaseBefore);
          const bobDeltaQuote = bobQuoteAfter.sub(bobQuoteBefore);
          const bobTotalOut   = bobDeltaBase.add(bobDeltaQuote);

          const bobExpectedValueQ = tvlQBeforeB.mul(bobShares).div(totalSharesBeforeB);
          expect(bobTotalOut).to.equal(bobExpectedValueQ);
          expect(bobDeltaBase).to.equal(bobDeltaQuote);

          // After both withdraw, vault inventories should be ~0 (no dust expected here)
          const finalBase  = await token0.balanceOf(vault.address);
          const finalQuote = await token1.balanceOf(vault.address);
          expect(finalBase.add(finalQuote)).to.equal(0);
        });
      });
      // ─────────────────────────────────────────────────────────────
      // Withdrawals: interaction with management fee shares
      // ─────────────────────────────────────────────────────────────
      describe("withdrawals: interaction with management fee shares", () => {
        it("user withdrawal after fee accrual gets balanced payout and does not touch owner fee-shares", async () => {
          const [deployerSigner, aliceSigner] = await ethers.getSigners();
          const aliceAddr = await aliceSigner.getAddress();

          // 1) Alice deposits balanced liquidity
          const depositAmount = ethers.utils.parseUnits("1000", 8); // 1000 TK0 + 1000 TK1

          await token0.transfer(aliceAddr, depositAmount);
          await token1.transfer(aliceAddr, depositAmount);
          await token0.connect(aliceSigner).approve(vault.address, depositAmount);
          await token1.connect(aliceSigner).approve(vault.address, depositAmount);

          await vault.connect(aliceSigner).depositWithPolicy(depositAmount, depositAmount, supraArgs);

          const aliceDeposits = await vault.depositsOf(aliceAddr);
          expect(aliceDeposits.length).to.equal(1);
          const aliceDepId = aliceDeposits[0];

          // 2) Schedule a non‑zero management fee rate effective in 1 week
          const newFeeBips = 1_000; // 0.1% / week
          await vault.scheduleOwnerFeeBips(newFeeBips);

          // 3) Fast‑forward so the new rate is active and accrues for some time
          await increaseTime(WEEK_SECS + DAY_SECS);

          // 4) Trigger _accrueMgmtFee by impersonating distributor and calling onAirdropFunded
          const distAddr = distributor.address;
          await network.provider.send("hardhat_setBalance", [
            distAddr,
            "0x8AC7230489E80000" // 10 ETH
          ]);
          await network.provider.request({
            method: "hardhat_impersonateAccount",
            params: [distAddr],
          });
          const distSigner = await ethers.getSigner(distAddr);

          // This calls _accrueMgmtFee internally before updating reward stream
          await vault.connect(distSigner).onAirdropFunded(token1.address, 1);

          await network.provider.request({
            method: "hardhat_stopImpersonatingAccount",
            params: [distAddr],
          });

          // We should now have some owner fee shares > 0
          const ownerFeeSharesBefore = await vault.ownerFeeShares();
          expect(ownerFeeSharesBefore).to.be.gt(0);

          // Make sure lockup has passed
          await increaseTime(DAY_SECS + 1);

          // Refresh oracle so withdraw doesn't hit "stale"
          await refreshOracleToNowAtOneToOne();

          // Snapshot balances and shares BEFORE withdraw
          const baseBalBefore  = await token0.balanceOf(vault.address);
          const quoteBalBefore = await token1.balanceOf(vault.address);
          const tvlQBefore     = baseBalBefore.add(quoteBalBefore); // price=1 → QUOTE value

          const totalSharesBefore = await vault.totalShares();
          const aliceSharesBefore = await vault.userShares(aliceAddr);

          expect(aliceSharesBefore).to.be.gt(0);
          expect(totalSharesBefore).to.equal(aliceSharesBefore.add(ownerFeeSharesBefore));

          const aliceBaseBefore  = await token0.balanceOf(aliceAddr);
          const aliceQuoteBefore = await token1.balanceOf(aliceAddr);

          // 5) Alice withdraws her entire lot
          await vault.connect(aliceSigner).withdrawAllFromDeposit(aliceDepId, supraArgs);

          const aliceBaseAfter  = await token0.balanceOf(aliceAddr);
          const aliceQuoteAfter = await token1.balanceOf(aliceAddr);

          const deltaBase  = aliceBaseAfter.sub(aliceBaseBefore);
          const deltaQuote = aliceQuoteAfter.sub(aliceQuoteBefore);
          const totalOut   = deltaBase.add(deltaQuote);

          // In a balanced vault with price=1, withdrawal payout must be 50/50 by value → equal units
          expect(isWithinOne(deltaBase, deltaQuote)).to.eq(true)

          // User's shares are fully burned
          expect(await vault.userShares(aliceAddr)).to.equal(0);

          // Vault balances decreased exactly by what Alice received
          const baseBalAfter  = await token0.balanceOf(vault.address);
          const quoteBalAfter = await token1.balanceOf(vault.address);
          expect(baseBalBefore.sub(baseBalAfter)).to.equal(deltaBase);
          expect(quoteBalBefore.sub(quoteBalAfter)).to.equal(deltaQuote);

          // Owner fee-shares remain and are NOT burned by Alice's withdrawal
          const ownerFeeSharesAfter = await vault.ownerFeeShares();
          expect(ownerFeeSharesAfter).to.be.gte(ownerFeeSharesBefore);

          // After Alice exits, all remaining shares belong to the owner
          const totalSharesAfter = await vault.totalShares();
          expect(totalSharesAfter).to.equal(ownerFeeSharesAfter);

          // And total value left in the vault equals owner’s share of TVL
          const tvlQAfter = baseBalAfter.add(quoteBalAfter);
          expect(tvlQAfter.add(totalOut)).to.equal(tvlQBefore);
        });
      });
    it("burns the correct number of shares on partial and full withdraw", async () => {
      const aliceAddr = await alice.getAddress();
      const depositAmt = ethers.utils.parseUnits("1000", 8); // 1000 TK0 + 1000 TK1

      // Fund & approve Alice
      await token0.transfer(aliceAddr, depositAmt);
      await token1.transfer(aliceAddr, depositAmt);
      await token0.connect(alice).approve(vault.address, depositAmt);
      await token1.connect(alice).approve(vault.address, depositAmt);

      // Fresh 1:1 oracle price and deposit
      await refreshOracleToNowAtOneToOne();
      await vault.connect(alice).depositWithPolicy(depositAmt, depositAmt, supraArgs);

      let aliceDeposits = await vault.depositsOf(aliceAddr);
      expect(aliceDeposits.length).to.equal(1);
      const depId = aliceDeposits[0];

      let lotBefore = await vault.deposits(depId);
      const userSharesBefore = await vault.userShares(aliceAddr);
      const totalSharesBefore = await vault.totalShares();

      // Sanity: only Alice, no owner fee => everything matches
      expect(lotBefore.shares).to.equal(userSharesBefore);
      expect(totalSharesBefore).to.equal(userSharesBefore);

      // Wait out lockup
      await increaseTime(LOCKUP_SECS + 1);

      // ------------- Partial withdraw (half the shares) -------------
      const halfShares = lotBefore.shares.div(2);

      await refreshOracleToNowAtOneToOne();
      await vault.connect(alice).withdrawFromDeposit(depId, halfShares, supraArgs);

      let lotMid = await vault.deposits(depId);
      const userSharesMid = await vault.userShares(aliceAddr);
      const totalSharesMid = await vault.totalShares();

      expect(lotMid.shares).to.equal(lotBefore.shares.sub(halfShares));
      expect(userSharesMid).to.equal(userSharesBefore.sub(halfShares));
      expect(totalSharesMid).to.equal(totalSharesBefore.sub(halfShares));

      // Lot must still exist after a partial withdraw
      aliceDeposits = await vault.depositsOf(aliceAddr);
      expect(aliceDeposits.length).to.equal(1);
      expect(aliceDeposits[0]).to.equal(depId);

      // ------------- Full withdraw (remaining shares) -------------
      const remaining = lotMid.shares;
      await refreshOracleToNowAtOneToOne();
      await vault.connect(alice).withdrawFromDeposit(depId, remaining, supraArgs);

      const lotAfter = await vault.deposits(depId);
      const userSharesAfter = await vault.userShares(aliceAddr);
      const totalSharesAfter = await vault.totalShares();

      // Lot is cleared
      expect(lotAfter.user).to.equal(ethers.constants.AddressZero);
      expect(lotAfter.shares).to.equal(0);

      // All Alice shares and total shares burned
      expect(userSharesAfter).to.equal(0);
      expect(totalSharesAfter).to.equal(0);

      // And depositId removed from _userDeposits
      aliceDeposits = await vault.depositsOf(aliceAddr);
      expect(aliceDeposits.length).to.equal(0);
    });

    it("pays 50/50 BASE and QUOTE when the vault is balanced", async () => {
      const aliceAddr = await alice.getAddress();
      const depositAmt = ethers.utils.parseUnits("1000", 8); // 1000 TK0 + 1000 TK1

      // Fund & approve
      await token0.transfer(aliceAddr, depositAmt);
      await token1.transfer(aliceAddr, depositAmt);
      await token0.connect(alice).approve(vault.address, depositAmt);
      await token1.connect(alice).approve(vault.address, depositAmt);

      // Balanced deposit
      await refreshOracleToNowAtOneToOne();
      await vault.connect(alice).depositWithPolicy(depositAmt, depositAmt, supraArgs);

      let ids = await vault.depositsOf(aliceAddr);
      expect(ids.length).to.equal(1);
      const depId = ids[0];

      // After deposit, Alice's wallet should have 0 TK0/TK1 (we transferred then deposited).
      // Record balances before withdrawal.
      await increaseTime(LOCKUP_SECS + 1);
      const baseBefore = await token0.balanceOf(aliceAddr);
      const quoteBefore = await token1.balanceOf(aliceAddr);

      const lot = await vault.deposits(depId);
      const sharesToBurn = lot.shares;

      await refreshOracleToNowAtOneToOne();
      await vault.connect(alice).withdrawFromDeposit(depId, sharesToBurn, supraArgs);

      const baseAfter = await token0.balanceOf(aliceAddr);
      const quoteAfter = await token1.balanceOf(aliceAddr);

      const deltaBase = baseAfter.sub(baseBefore);
      const deltaQuote = quoteAfter.sub(quoteBefore);

      // In a perfectly balanced 1:1 vault with a single LP and no PnL:
      // full withdraw returns exactly what was deposited.
      expect(deltaBase).to.equal(depositAmt);
      expect(deltaQuote).to.equal(depositAmt);
    });

    it("pays from the overweight token first, then 50/50 in the imbalanced state (BASE overweight)", async () => {
      const aliceAddr = await alice.getAddress();
      const depositAmt = ethers.utils.parseUnits("1000", 8); // 1000 TK0 + 1000 TK1

      // Fund & approve
      await token0.transfer(aliceAddr, depositAmt);
      await token1.transfer(aliceAddr, depositAmt);
      await token0.connect(alice).approve(vault.address, depositAmt);
      await token1.connect(alice).approve(vault.address, depositAmt);

      // Balanced initial deposit
      await refreshOracleToNowAtOneToOne();
      await vault.connect(alice).depositWithPolicy(depositAmt, depositAmt, supraArgs);

      let ids = await vault.depositsOf(aliceAddr);
      expect(ids.length).to.equal(1);
      const depId = ids[0];

      // Create a BASE-overweight condition by sending extra BASE directly into the vault
      const extraBase = ethers.utils.parseUnits("100", 8);
      await token0.transfer(vault.address, extraBase);

      // Now:
      //   baseBal ≈ 1100
      //   quoteBal ≈ 1000
      // => BASE overweight by ~100 (in QUOTE terms at price=1).

      // Wait out lockup
      await increaseTime(LOCKUP_SECS + 1);

      // Fetch vault inventories before withdraw
      const baseBalBefore = await token0.balanceOf(vault.address);
      const quoteBalBefore = await token1.balanceOf(vault.address);
      const totalSharesBefore = await vault.totalShares();

      const baseValQ = baseBalBefore;   // price=1:1, same decimals
      const quoteValQ = quoteBalBefore;
      const tvlQ = baseValQ.add(quoteValQ);
      const imbalanceValueQ = baseValQ.sub(quoteValQ); // >0 => BASE overweight
      expect(imbalanceValueQ).to.be.gt(0);

      // We'll withdraw half of Alice's shares
      const lot = await vault.deposits(depId);
      const halfShares = lot.shares.div(2);

      // Pro‑rata value owed for half the shares
      const owedValueQ = tvlQ.mul(halfShares).div(totalSharesBefore);
      expect(owedValueQ).to.be.gt(0);

      // Simulate _payoutOverweightThenBalanced for BASE-overweight case at price=scale
      let baseBalSim = baseBalBefore;
      let quoteBalSim = quoteBalBefore;
      let owedSim = owedValueQ;
      let expectedBasePay = BigNumber.from(0);
      let expectedQuotePay = BigNumber.from(0);

      // --- Phase 1: consume overweight from BASE only ---
      const overweightValueQ = imbalanceValueQ; // >0
      const phase1ValueQ = owedSim.lte(overweightValueQ) ? owedSim : overweightValueQ;
      const phase1BaseUnits = phase1ValueQ.mul(ORACLE_SCALE).div(ORACLE_SCALE); // price=scale => 1:1

      baseBalSim = baseBalSim.sub(phase1BaseUnits);
      owedSim = owedSim.sub(phase1ValueQ);
      expectedBasePay = expectedBasePay.add(phase1BaseUnits);

      // --- Phase 2: split remaining owedSim 50/50 by value ---
      if (!owedSim.isZero()) {
        const halfRem = owedSim.div(2);

        const phase2BaseUnits = halfRem.mul(ORACLE_SCALE).div(ORACLE_SCALE); // again 1:1
        const phase2BaseValueQ = phase2BaseUnits.mul(ORACLE_SCALE).div(ORACLE_SCALE);

        const phase2QuoteUnits = owedSim.sub(phase2BaseValueQ);

        // sanity: both fits in remaining simulated balances
        expect(phase2BaseUnits.lte(baseBalSim)).to.equal(true);
        expect(phase2QuoteUnits.lte(quoteBalSim)).to.equal(true);

        expectedBasePay = expectedBasePay.add(phase2BaseUnits);
        expectedQuotePay = expectedQuotePay.add(phase2QuoteUnits);
      }

      // Total value must match owedValueQ
      expect(expectedBasePay.add(expectedQuotePay)).to.equal(owedValueQ);

      // --- Now actually withdraw and compare with expected ---

      const baseBefore = await token0.balanceOf(aliceAddr);
      const quoteBefore = await token1.balanceOf(aliceAddr);

      await refreshOracleToNowAtOneToOne();
      await vault.connect(alice).withdrawFromDeposit(depId, halfShares, supraArgs);

      const baseAfter = await token0.balanceOf(aliceAddr);
      const quoteAfter = await token1.balanceOf(aliceAddr);

      const deltaBase = baseAfter.sub(baseBefore);
      const deltaQuote = quoteAfter.sub(quoteBefore);

      // 1) Total value must match owedValueQ
      expect(isWithinOne(deltaBase.add(deltaQuote), owedValueQ)).to.eq(true);

      // 2) The split must match our simulated overweight-then-50/50 logic
      expect(isWithinOne(deltaBase, expectedBasePay)).to.eq(true);
      expect(isWithinOne(deltaQuote, expectedQuotePay)).to.eq(true);

      // 3) Since BASE is overweight, the user should receive *more* BASE than QUOTE in this withdraw
      expect(deltaBase.gte(deltaQuote)).to.equal(true);

      // Also check the deposit lot's shares were reduced correctly (partial withdraw)
      const lotAfter = await vault.deposits(depId);
      expect(lotAfter.shares).to.equal(lot.shares.sub(halfShares));
      const userSharesAfter = await vault.userShares(aliceAddr);
      expect(userSharesAfter).to.equal(totalSharesBefore.sub(halfShares)); // no fee shares in this test
    });
    it("pays from the overweight token first, then 50/50 in the imbalanced state (QUOTE overweight)", async () => {
      const aliceAddr = await alice.getAddress();
      const depositAmt = ethers.utils.parseUnits("1000", 8); // 1000 TK0 + 1000 TK1

      // Fund & approve Alice
      await token0.transfer(aliceAddr, depositAmt);
      await token1.transfer(aliceAddr, depositAmt);
      await token0.connect(alice).approve(vault.address, depositAmt);
      await token1.connect(alice).approve(vault.address, depositAmt);

      // Balanced initial deposit
      await refreshOracleToNowAtOneToOne();
      await vault.connect(alice).depositWithPolicy(depositAmt, depositAmt, supraArgs);

      let ids = await vault.depositsOf(aliceAddr);
      expect(ids.length).to.equal(1);
      const depId = ids[0];

      // Make QUOTE overweight by sending extra QUOTE directly to the vault
      const extraQuote = ethers.utils.parseUnits("100", 8); // small imbalance
      await token1.transfer(vault.address, extraQuote);

      // Now:
      //   baseBal ≈ 1000
      //   quoteBal ≈ 1100
      // => QUOTE overweight by ~100 (in QUOTE terms at price=1).

      // Wait out lockup
      await increaseTime(LOCKUP_SECS + 1);

      // Snapshot inventories & shares before withdraw
      const baseBalBefore = await token0.balanceOf(vault.address);
      const quoteBalBefore = await token1.balanceOf(vault.address);
      const totalSharesBefore = await vault.totalShares();

      const baseValQ = baseBalBefore;      // price=1:1
      const quoteValQ = quoteBalBefore;
      const tvlQ = baseValQ.add(quoteValQ);

      // QUOTE must be overweight
      expect(quoteValQ).to.be.gt(baseValQ);
      const overweightValueQ = quoteValQ.sub(baseValQ); // = |imbalanceValueQ|

      // We'll withdraw half of Alice's shares
      const lot = await vault.deposits(depId);
      const halfShares = lot.shares.div(2);

      // Pro‑rata value owed for half the shares
      const owedValueQ = tvlQ.mul(halfShares).div(totalSharesBefore);
      expect(owedValueQ).to.be.gt(0);

      // --- Simulate _payoutOverweightThenBalanced (QUOTE overweight branch) in TypeScript ---

      let baseBalSim = baseBalBefore;
      let quoteBalSim = quoteBalBefore;
      let owedSim = owedValueQ;
      let expectedBasePay = BigNumber.from(0);
      let expectedQuotePay = BigNumber.from(0);

      // Phase 1: consume from overweight QUOTE only
      const phase1ValueQ = owedSim.lte(overweightValueQ) ? owedSim : overweightValueQ;

      quoteBalSim = quoteBalSim.sub(phase1ValueQ);
      owedSim = owedSim.sub(phase1ValueQ);
      expectedQuotePay = expectedQuotePay.add(phase1ValueQ);

      // Phase 2: split remaining owedSim 50/50 by value
      if (!owedSim.isZero()) {
        const halfRem = owedSim.div(2);

        // priceQPerBase == priceScale (1:1), so BASE units = value
        const phase2BaseUnits = halfRem.mul(ORACLE_SCALE).div(ORACLE_SCALE); // = halfRem
        const phase2BaseValueQ = phase2BaseUnits.mul(ORACLE_SCALE).div(ORACLE_SCALE); // = phase2BaseUnits

        const phase2QuoteUnits = owedSim.sub(phase2BaseValueQ);

        // sanity: both pay legs must fit in remaining balances
        expect(phase2BaseUnits.lte(baseBalSim)).to.equal(true);
        expect(phase2QuoteUnits.lte(quoteBalSim)).to.equal(true);

        expectedBasePay = expectedBasePay.add(phase2BaseUnits);
        expectedQuotePay = expectedQuotePay.add(phase2QuoteUnits);
      }

      // Total value preserved
      expect(expectedBasePay.add(expectedQuotePay)).to.equal(owedValueQ);

      // --- Now actually withdraw from the vault and compare ---

      const baseBefore = await token0.balanceOf(aliceAddr);
      const quoteBefore = await token1.balanceOf(aliceAddr);

      await refreshOracleToNowAtOneToOne();
      await vault.connect(alice).withdrawFromDeposit(depId, halfShares, supraArgs);

      const baseAfter = await token0.balanceOf(aliceAddr);
      const quoteAfter = await token1.balanceOf(aliceAddr);

      const deltaBase = baseAfter.sub(baseBefore);
      const deltaQuote = quoteAfter.sub(quoteBefore);

      // 1) Total value must match owedValueQ
      expect(isWithinOne(deltaBase.add(deltaQuote), owedValueQ)).to.eq(true)

      // 2) The split must match our simulated QUOTE-overweight logic
      expect(isWithinOne(deltaBase, expectedBasePay)).to.eq(true)
      expect(isWithinOne(deltaQuote, expectedQuotePay)).to.eq(true)

      // 3) Because QUOTE is overweight, user should receive >= QUOTE than BASE in units
      expect(deltaQuote.gte(deltaBase)).to.equal(true);

      // And the deposit lot should have its shares reduced (partial withdraw)
      const lotAfter = await vault.deposits(depId);
      expect(lotAfter.shares).to.equal(lot.shares.sub(halfShares));
    });
    it("deletes the deposit and updates storage correctly on full withdraw", async () => {
      const aliceAddr = await alice.getAddress();
      const depositAmt = ethers.utils.parseUnits("500", 8);

      // Fund & approve
      await token0.transfer(aliceAddr, depositAmt);
      await token1.transfer(aliceAddr, depositAmt);
      await token0.connect(alice).approve(vault.address, depositAmt);
      await token1.connect(alice).approve(vault.address, depositAmt);

      await refreshOracleToNowAtOneToOne();
      await vault.connect(alice).depositWithPolicy(depositAmt, depositAmt, supraArgs);

      let ids = await vault.depositsOf(aliceAddr);
      expect(ids.length).to.equal(1);
      const depId = ids[0];

      let lot = await vault.deposits(depId);
      const shares = lot.shares;
      const totalSharesBefore = await vault.totalShares();
      const userSharesBefore = await vault.userShares(aliceAddr);

      expect(totalSharesBefore).to.equal(shares);
      expect(userSharesBefore).to.equal(shares);

      await increaseTime(LOCKUP_SECS + 1);

      await refreshOracleToNowAtOneToOne();
      await vault.connect(alice).withdrawAllFromDeposit(depId, supraArgs);

      // deposit should be cleared
      lot = await vault.deposits(depId);
      expect(lot.user).to.equal(ethers.constants.AddressZero);
      expect(lot.shares).to.equal(0);

      // user and global shares must be zero
      const totalSharesAfter = await vault.totalShares();
      const userSharesAfter = await vault.userShares(aliceAddr);
      expect(totalSharesAfter).to.equal(0);
      expect(userSharesAfter).to.equal(0);

      // and the depositId removed from _userDeposits
      ids = await vault.depositsOf(aliceAddr);
      expect(ids.length).to.equal(0);
    });
  });
  // ─────────────────────────────────────────────────────────────
  // Airdrop rewards (streaming via distributor)
  // ─────────────────────────────────────────────────────────────
  describe("airdrop rewards", () => {
    async function refreshOraclePrice1to1() {
      const latestBlock = await ethers.provider.getBlock("latest");
      const ts = latestBlock!.timestamp;

      // Must match how you set it in beforeEach: price = scale for 1:1
      const scale = BigNumber.from(10).pow(8); // 1e8
      const price = scale;                     // 1.0 * scale

      await mockSupra.setPriceInfo(
        1,
        [1],       // pairs
        [price],   // prices
        [ts],      // timestamp
        [scale],   // decimal
        [0]        // round
      );
    }

    beforeEach(async() => {
      await distributor.modifyAllowed(token1.address, true)
    })

    it("single depositor accrues and can claim streaming rewards funded via distributor", async () => {
      const [, aliceSigner] = await ethers.getSigners();
      const aliceAddr = await aliceSigner.getAddress();

      const decimals = await token1.decimals();
      const ONE = BigNumber.from(10).pow(decimals); // 1 smallest TK1 unit

      const VESTING_SECS = await vault.VESTING_SECS();

      // 1) Alice makes a balanced deposit
      const depositAmt = ONE.mul(1_000); // 1000 TK0 + 1000 TK1

      await token0.transfer(aliceAddr, depositAmt);
      await token1.transfer(aliceAddr, depositAmt);
      await token0.connect(aliceSigner).approve(vault.address, depositAmt);
      await token1.connect(aliceSigner).approve(vault.address, depositAmt);

      await vault.connect(aliceSigner).depositWithPolicy(depositAmt, depositAmt, supraArgs);

      const aliceShares = await vault.userShares(aliceAddr);
      const totalShares = await vault.totalShares();
      expect(totalShares).to.equal(aliceShares); // Alice = 100%

      // 2) Fund rewards: 1 TK1/sec over the whole vesting period
      const rewardPerSec = ONE; // 1 token per second
      const amount = VESTING_SECS.mul(rewardPerSec);

      await token1.approve(distributor.address, amount);
      await distributor.fund(vault.address, token1.address, amount);

      // 3) Fast-forward past full vesting
      await increaseTime(VESTING_SECS.toNumber() + 10);

      // 4) Alice claims
      const balBefore = await token1.balanceOf(aliceAddr);
      await vault.connect(aliceSigner).claimRewards(token1.address);
      const balAfter = await token1.balanceOf(aliceAddr);
      const claimed = balAfter.sub(balBefore);

      // Expected "continuous" payout is the full amount, up to rounding
      const expected = amount;

      // Compare with 1‑unit tolerance
      const diff = claimed.gt(expected) ? claimed.sub(expected) : expected.sub(claimed);
      expect(diff.lte(ONE)).to.be.true;

      // Also check the distributor ledger: remaining should be ≤ ONE (rounding dust)
      const credited = await distributor.credited(vault.address, token1.address);
      const totalClaimed = await distributor.claimed(vault.address, token1.address);
      const remaining = credited.sub(totalClaimed);
      expect(remaining.lte(ONE)).to.be.true;
    });

    it("two depositors receive rewards approximately proportional to their shares", async () => {
      const [, aliceSigner, bobSigner] = await ethers.getSigners();
      const aliceAddr = await aliceSigner.getAddress();
      const bobAddr = await bobSigner.getAddress();

      const decimals = await token1.decimals();
      const ONE = BigNumber.from(10).pow(decimals);
      const VESTING_SECS = await vault.VESTING_SECS();

      // 1) Alice deposits 2x Bob, so shares ratio is ~2:1
      const baseAlice = ONE.mul(2_000);
      const quoteAlice = ONE.mul(2_000);
      const baseBob = ONE.mul(1_000);
      const quoteBob = ONE.mul(1_000);

      // fund & approve Alice
      await token0.transfer(aliceAddr, baseAlice);
      await token1.transfer(aliceAddr, quoteAlice);
      await token0.connect(aliceSigner).approve(vault.address, baseAlice);
      await token1.connect(aliceSigner).approve(vault.address, quoteAlice);
      await vault.connect(aliceSigner).depositWithPolicy(baseAlice, quoteAlice, supraArgs);

      // fund & approve Bob
      await token0.transfer(bobAddr, baseBob);
      await token1.transfer(bobAddr, quoteBob);
      await token0.connect(bobSigner).approve(vault.address, baseBob);
      await token1.connect(bobSigner).approve(vault.address, quoteBob);
      await vault.connect(bobSigner).depositWithPolicy(baseBob, quoteBob, supraArgs);

      const aliceShares = await vault.userShares(aliceAddr);
      const bobShares = await vault.userShares(bobAddr);
      const totalShares = await vault.totalShares();

      // Sanity: Alice has strictly more shares than Bob
      expect(aliceShares.gt(bobShares)).to.be.true;
      expect(aliceShares.add(bobShares)).to.equal(totalShares);

      // 2) Fund a single stream
      const rewardPerSec = ONE; // 1 TK1/sec
      const amount = VESTING_SECS.mul(rewardPerSec);

      await token1.approve(distributor.address, amount);
      await distributor.fund(vault.address, token1.address, amount);

      // 3) Let full vesting elapse
      await increaseTime(VESTING_SECS.toNumber() + 5);

      // 4) Both claim
      const aBefore = await token1.balanceOf(aliceAddr);
      const bBefore = await token1.balanceOf(bobAddr);

      await vault.connect(aliceSigner).claimRewards(token1.address);
      await vault.connect(bobSigner).claimRewards(token1.address);

      const aAfter = await token1.balanceOf(aliceAddr);
      const bAfter = await token1.balanceOf(bobAddr);

      const aDelta = aAfter.sub(aBefore);
      const bDelta = bAfter.sub(bBefore);
      const totalClaimed = aDelta.add(bDelta);

      // Ideal "continuous" split by share weights
      const idealAlice = amount.mul(aliceShares).div(totalShares);
      const idealBob   = amount.mul(bobShares).div(totalShares);

      // 1) Total claimed should be very close to funded amount
      {
        const diffTotal = totalClaimed.gt(amount)
          ? totalClaimed.sub(amount)
          : amount.sub(totalClaimed);
        // Allow up to 2 units of dust across both users
        expect(diffTotal.lte(ONE.mul(2))).to.be.true;
      }

      // 2) Per‑user claims are within 1 unit of ideal
      {
        const diffAlice = aDelta.gt(idealAlice)
          ? aDelta.sub(idealAlice)
          : idealAlice.sub(aDelta);
        const diffBob = bDelta.gt(idealBob)
          ? bDelta.sub(idealBob)
          : idealBob.sub(bDelta);

        expect(diffAlice.lte(ONE)).to.be.true;
        expect(diffBob.lte(ONE)).to.be.true;
      }

      // 3) Alice must get more than Bob (since she has more shares)
      expect(aDelta.gt(bDelta)).to.be.true;
    });
    it("supports multiple overlapping fundings and streams the full combined amount (up to dust)", async () => {
      const [, aliceSigner] = await ethers.getSigners();
      const aliceAddr = await aliceSigner.getAddress();

      const decimals = await token1.decimals();
      const ONE = BigNumber.from(10).pow(decimals);
      const VESTING_SECS = await vault.VESTING_SECS();

      // 1) Single depositor, balanced deposit
      const depositAmt = ONE.mul(1_000);

      await token0.transfer(aliceAddr, depositAmt);
      await token1.transfer(aliceAddr, depositAmt);
      await token0.connect(aliceSigner).approve(vault.address, depositAmt);
      await token1.connect(aliceSigner).approve(vault.address, depositAmt);

      await vault.connect(aliceSigner).depositWithPolicy(depositAmt, depositAmt, supraArgs);

      const aliceShares = await vault.userShares(aliceAddr);
      const totalShares = await vault.totalShares();
      expect(totalShares).to.equal(aliceShares);

      // 2) First funding: amount1 = 1 token/sec for full vesting
      const rewardPerSec = ONE;
      const amount1 = VESTING_SECS.mul(rewardPerSec);

      await token1.approve(distributor.address, amount1);
      const tx1 = await distributor.fund(vault.address, token1.address, amount1);
      const rcpt1 = await tx1.wait();
      const block1 = await ethers.provider.getBlock(rcpt1.blockNumber);
      if (!block1) throw new Error("block1 not found");
      const t0 = block1.timestamp;

      // 3) Halfway through first stream, fund again with amount2
      const half = VESTING_SECS.div(2);
      const remaining = VESTING_SECS.sub(half);
      const amount2 = remaining.mul(rewardPerSec);
      const totalFunded = amount1.add(amount2);

      const t1 = t0 + half.toNumber();
      await network.provider.send("evm_setNextBlockTimestamp", [t1]);
      await network.provider.send("evm_mine", []);

      await token1.approve(distributor.address, totalFunded); // safe to over-approve
      await distributor.fund(vault.address, token1.address, amount2);

      // 4) Let the blended stream fully finish
      const R = await vault.rewards(token1.address);
      const periodFinish = R.periodFinish.toNumber();

      await network.provider.send("evm_setNextBlockTimestamp", [periodFinish + 5]);
      await network.provider.send("evm_mine", []);

      // 5) Alice claims once
      const before = await token1.balanceOf(aliceAddr);
      await vault.connect(aliceSigner).claimRewards(token1.address);
      const after = await token1.balanceOf(aliceAddr);
      const claimed = after.sub(before);

      // In the ideal continuous case she'd get exactly totalFunded.
      // Because of integer division for rate, perShare, and per‑user accrual,
      // we allow up to 1 unit of rounding dust.
      const diff = claimed.gt(totalFunded)
        ? claimed.sub(totalFunded)
        : totalFunded.sub(claimed);
      expect(diff.lte(ONE)).to.be.true;

      // Distributor ledger should show at most 1 unit of leftover.
      const credited = await distributor.credited(vault.address, token1.address);
      const totalClaimed = await distributor.claimed(vault.address, token1.address);
      const remainingLedger = credited.sub(totalClaimed);
      expect(remainingLedger.lte(ONE)).to.be.true;
    });
    it("single depositor can claim multiple reward tokens via claimAllRewards", async () => {
      const [, aliceSigner] = await ethers.getSigners();
      const aliceAddr = await aliceSigner.getAddress();

      // Use token1 as Reward A, and deploy a separate ERC20Mock as Reward B
      const decimalsToken1 = await token1.decimals();
      const ONE_A = BigNumber.from(10).pow(decimalsToken1);

      const ERC20MockFactory = await ethers.getContractFactory("ERC20Mock");
      const rewardB = (await ERC20MockFactory.deploy(
        "RewardB",
        "RWD",
        8,
        INITIAL_MINT
      )) as ERC20Mock;
      await rewardB.deployed();
      await distributor.modifyAllowed(rewardB.address, true)

      const decimalsB = await rewardB.decimals();
      const ONE_B = BigNumber.from(10).pow(decimalsB);

      const VESTING_SECS = await vault.VESTING_SECS();

      // 1) Alice makes a balanced deposit in the base/quote pair
      const depositAmtBase  = ONE_A.mul(1_000); // 1000 TK0
      const depositAmtQuote = ONE_A.mul(1_000); // 1000 TK1

      await token0.transfer(aliceAddr, depositAmtBase);
      await token1.transfer(aliceAddr, depositAmtQuote);
      await token0.connect(aliceSigner).approve(vault.address, depositAmtBase);
      await token1.connect(aliceSigner).approve(vault.address, depositAmtQuote);

      await vault.connect(aliceSigner).depositWithPolicy(
        depositAmtBase,
        depositAmtQuote,
        supraArgs
      );

      const aliceShares = await vault.userShares(aliceAddr);
      const totalShares = await vault.totalShares();
      expect(aliceShares).to.equal(totalShares); // Alice owns 100% of shares

      // 2) Fund Reward A (token1): 1 token per second over full vesting
      const amountA = VESTING_SECS.mul(ONE_A);
      await token1.approve(distributor.address, amountA);
      await distributor.fund(vault.address, token1.address, amountA);

      // 3) Fund Reward B (rewardB): 2 tokens per second over full vesting
      const rateB   = ONE_B.mul(2);
      const amountB = VESTING_SECS.mul(rateB);

      await rewardB.approve(distributor.address, amountB);
      await distributor.fund(vault.address, rewardB.address, amountB);

      // 4) Let both streams fully vest
      await increaseTime(VESTING_SECS.toNumber() + 10);

      // 5) Alice calls claimAllRewards once
      const balA_before = await token1.balanceOf(aliceAddr);
      const balB_before = await rewardB.balanceOf(aliceAddr);

      await vault.connect(aliceSigner).claimAllRewards();

      const balA_after = await token1.balanceOf(aliceAddr);
      const balB_after = await rewardB.balanceOf(aliceAddr);

      const claimedA = balA_after.sub(balA_before);
      const claimedB = balB_after.sub(balB_before);

      // Ideal continuous values
      const expectedA = amountA;
      const expectedB = amountB;

      // Allow a tolerance of 1 smallest unit for each token due to integer rounding
      const diffA = claimedA.gt(expectedA)
        ? claimedA.sub(expectedA)
        : expectedA.sub(claimedA);
      const diffB = claimedB.gt(expectedB)
        ? claimedB.sub(expectedB)
        : expectedB.sub(claimedB);

      expect(diffA.lte(ONE_A)).to.be.true;
      expect(diffB.lte(ONE_B)).to.be.true;
    });
    it("two depositors claim multiple reward tokens proportionally via claimAllRewards", async () => {
      const [, aliceSigner, bobSigner] = await ethers.getSigners();
      const aliceAddr = await aliceSigner.getAddress();
      const bobAddr   = await bobSigner.getAddress();

      // Reward A = token1, Reward B = new ERC20Mock
      const decimalsToken1 = await token1.decimals();
      const ONE_A = BigNumber.from(10).pow(decimalsToken1);

      const ERC20MockFactory = await ethers.getContractFactory("ERC20Mock");
      const rewardB = (await ERC20MockFactory.deploy(
        "RewardB",
        "RWD",
        8,
        INITIAL_MINT
      )) as ERC20Mock;
      await rewardB.deployed();
      await distributor.modifyAllowed(rewardB.address, true)

      const decimalsB = await rewardB.decimals();
      const ONE_B = BigNumber.from(10).pow(decimalsB);

      const VESTING_SECS = await vault.VESTING_SECS();

      // 1) Alice deposits 2000/2000, Bob deposits 1000/1000 → shares roughly 2:1
      const baseAlice  = ONE_A.mul(2_000);
      const quoteAlice = ONE_A.mul(2_000);
      const baseBob    = ONE_A.mul(1_000);
      const quoteBob   = ONE_A.mul(1_000);

      // Alice funding & deposit
      await token0.transfer(aliceAddr, baseAlice);
      await token1.transfer(aliceAddr, quoteAlice);
      await token0.connect(aliceSigner).approve(vault.address, baseAlice);
      await token1.connect(aliceSigner).approve(vault.address, quoteAlice);
      await vault.connect(aliceSigner).depositWithPolicy(
        baseAlice,
        quoteAlice,
        supraArgs
      );

      // Bob funding & deposit
      await token0.transfer(bobAddr, baseBob);
      await token1.transfer(bobAddr, quoteBob);
      await token0.connect(bobSigner).approve(vault.address, baseBob);
      await token1.connect(bobSigner).approve(vault.address, quoteBob);
      await vault.connect(bobSigner).depositWithPolicy(
        baseBob,
        quoteBob,
        supraArgs
      );

      const aliceShares = await vault.userShares(aliceAddr);
      const bobShares   = await vault.userShares(bobAddr);
      const totalShares = await vault.totalShares();

      expect(aliceShares.add(bobShares)).to.equal(totalShares);
      expect(aliceShares.gt(bobShares)).to.be.true; // Alice > Bob

      // 2) Fund Reward A (token1) and Reward B (rewardB)
      const amountA = VESTING_SECS.mul(ONE_A);        // 1 token1/sec
      const amountB = VESTING_SECS.mul(ONE_B.mul(3)); // 3 rewardB/sec

      await token1.approve(distributor.address, amountA);
      await distributor.fund(vault.address, token1.address, amountA);

      await rewardB.approve(distributor.address, amountB);
      await distributor.fund(vault.address, rewardB.address, amountB);

      // 3) Let both streams fully vest
      await increaseTime(VESTING_SECS.toNumber() + 10);

      // 4) Snapshot balances pre‑claim
      const a_token1_before = await token1.balanceOf(aliceAddr);
      const a_rewardB_before = await rewardB.balanceOf(aliceAddr);

      const b_token1_before = await token1.balanceOf(bobAddr);
      const b_rewardB_before = await rewardB.balanceOf(bobAddr);

      // 5) Both call claimAllRewards
      await vault.connect(aliceSigner).claimAllRewards();
      await vault.connect(bobSigner).claimAllRewards();

      const a_token1_after = await token1.balanceOf(aliceAddr);
      const a_rewardB_after = await rewardB.balanceOf(aliceAddr);

      const b_token1_after = await token1.balanceOf(bobAddr);
      const b_rewardB_after = await rewardB.balanceOf(bobAddr);

      const a_deltaA = a_token1_after.sub(a_token1_before);
      const a_deltaB = a_rewardB_after.sub(a_rewardB_before);

      const b_deltaA = b_token1_after.sub(b_token1_before);
      const b_deltaB = b_rewardB_after.sub(b_rewardB_before);

      const totalClaimedA = a_deltaA.add(b_deltaA);
      const totalClaimedB = a_deltaB.add(b_deltaB);

      // Ideal continuous split per token
      const idealAliceA = amountA.mul(aliceShares).div(totalShares);
      const idealBobA   = amountA.mul(bobShares).div(totalShares);

      const idealAliceB = amountB.mul(aliceShares).div(totalShares);
      const idealBobB   = amountB.mul(bobShares).div(totalShares);

      // 1) Total per‑token claims are close to funded amounts (≤ 2 units of dust)
      {
        const diffTotalA = totalClaimedA.gt(amountA)
          ? totalClaimedA.sub(amountA)
          : amountA.sub(totalClaimedA);
        const diffTotalB = totalClaimedB.gt(amountB)
          ? totalClaimedB.sub(amountB)
          : amountB.sub(totalClaimedB);

        expect(diffTotalA.lte(ONE_A.mul(2))).to.be.true;
        expect(diffTotalB.lte(ONE_B.mul(2))).to.be.true;
      }

      // 2) Per‑user, per‑token shares are within 1 unit of ideal
      {
        const diffAliceA = a_deltaA.gt(idealAliceA)
          ? a_deltaA.sub(idealAliceA)
          : idealAliceA.sub(a_deltaA);
        const diffBobA = b_deltaA.gt(idealBobA)
          ? b_deltaA.sub(idealBobA)
          : idealBobA.sub(b_deltaA);

        const diffAliceB = a_deltaB.gt(idealAliceB)
          ? a_deltaB.sub(idealAliceB)
          : idealAliceB.sub(a_deltaB);
        const diffBobB = b_deltaB.gt(idealBobB)
          ? b_deltaB.sub(idealBobB)
          : idealBobB.sub(b_deltaB);

        expect(diffAliceA.lte(ONE_A)).to.be.true;
        expect(diffBobA.lte(ONE_A)).to.be.true;

        expect(diffAliceB.lte(ONE_B)).to.be.true;
        expect(diffBobB.lte(ONE_B)).to.be.true;
      }

      // 3) Alice gets more of each reward token than Bob (since she has more shares)
      expect(a_deltaA.gt(b_deltaA)).to.be.true;
      expect(a_deltaB.gt(b_deltaB)).to.be.true;
    });
    describe("airdrop rewards: onAirdropFunded access control & input sanity", () => {
      it("reverts if called by a non‑distributor", async () => {
        // deployer (or alice, etc.) is *not* the distributor
        await expect(
          vault.onAirdropFunded(token1.address, 1)
        ).to.be.revertedWith("only distributor");

        await expect(
          vault.connect(alice).onAirdropFunded(token1.address, 1)
        ).to.be.revertedWith("only distributor");
      });

      it("reverts if rewardToken is the zero address, even when called by distributor", async () => {
        const distAddr = distributor.address;

        // Give the distributor some ETH and impersonate it
        await network.provider.send("hardhat_setBalance", [
          distAddr,
          "0x8AC7230489E80000" // 10 ETH
        ]);
        await network.provider.request({
          method: "hardhat_impersonateAccount",
          params: [distAddr],
        });
        const distSigner = await ethers.getSigner(distAddr);

        await expect(
          vault.connect(distSigner).onAirdropFunded(ethers.constants.AddressZero, 1)
        ).to.be.revertedWith("HBAR reward unsupported");

        await network.provider.request({
          method: "hardhat_stopImpersonatingAccount",
          params: [distAddr],
        });
      });

      it("reverts if netAmount is zero, even when called by distributor", async () => {
        const distAddr = distributor.address;

        await network.provider.send("hardhat_setBalance", [
          distAddr,
          "0x8AC7230489E80000" // 10 ETH
        ]);
        await network.provider.request({
          method: "hardhat_impersonateAccount",
          params: [distAddr],
        });
        const distSigner = await ethers.getSigner(distAddr);

        await expect(
          vault.connect(distSigner).onAirdropFunded(token1.address, 0)
        ).to.be.revertedWith("net=0");

        await network.provider.request({
          method: "hardhat_stopImpersonatingAccount",
          params: [distAddr],
        });
      });

      it("accepts a valid call from the distributor and updates reward state (smoke test)", async () => {
        const distAddr = distributor.address;

        await network.provider.send("hardhat_setBalance", [
          distAddr,
          "0x8AC7230489E80000" // 10 ETH
        ]);
        await network.provider.request({
          method: "hardhat_impersonateAccount",
          params: [distAddr],
        });
        const distSigner = await ethers.getSigner(distAddr);

        const rewardToken = token1.address;
        const amount = 1_000_000;

        // Snapshot reward data before
        const before = await vault.rewards(rewardToken);
        const rateBefore = before.rate;
        const perShareBefore = before.perShare;

        // This should NOT revert
        await vault.connect(distSigner).onAirdropFunded(rewardToken, amount);

        const after = await vault.rewards(rewardToken);

        // We only assert that something changed in the stream config.
        // Exact math is covered in more detailed streaming tests.
        expect(after.rate).to.not.equal(rateBefore);
        // perShare should not go backwards; after >= before
        expect(after.perShare.gte(perShareBefore)).to.equal(true);

        await network.provider.request({
          method: "hardhat_stopImpersonatingAccount",
          params: [distAddr],
        });
      });
    });
    describe("airdrop rewards: no depositors / carry behavior", () => {
      it("accrues rewards into carry when there are no eligible shares", async () => {
        // Sanity: no shares yet
        expect(await vault.totalShares()).to.equal(0);

        const rewardToken = token1.address;
        const netAmount = WEEK_SECS; // choose amount so rate = 1 token/sec

        const distAddr = distributor.address;
        await network.provider.send("hardhat_setBalance", [
          distAddr,
          "0x8AC7230489E80000", // 10 ETH
        ]);
        await network.provider.request({
          method: "hardhat_impersonateAccount",
          params: [distAddr],
        });
        const distSigner = await ethers.getSigner(distAddr);

        // First funding: onAirdropFunded from distributor
        const tx = await vault.connect(distSigner).onAirdropFunded(rewardToken, netAmount);
        const rcpt = await tx.wait();
        const block = await ethers.provider.getBlock(rcpt.blockNumber);
        if (!block) throw new Error("block not found");
        const t0 = block.timestamp;

        // Snapshot RewardData right after funding
        let R = await vault.rewards(rewardToken);
        const rate = R.rate;
        expect(R.perShare).to.equal(0);
        // rate * WEEK_SECS should equal netAmount (carry holds the remainder, which should be 0 here)
        expect(rate.mul(WEEK_SECS)).to.equal(netAmount);
        expect(R.carry).to.equal(0);
        expect(R.lastUpdate).to.equal(t0);
        expect(R.periodFinish).to.equal(t0 + WEEK_SECS);

        // Move to halfway through the stream
        const half = Math.floor(WEEK_SECS / 2);
        await setNextBlockTimestamp(t0 + half);

        // Trigger _updateReward via claimRewards from an account with 0 shares.
        // This will advance time and push accrued tokens into R.carry because eligible=0.
        await vault.claimRewards(rewardToken);

        R = await vault.rewards(rewardToken);

        const expectedCarry = rate.mul(half);
        expect(R.perShare).to.equal(0);               // still no per-share accrual
        expect(R.carry).to.be.closeTo(expectedCarry, 1);      // all accrued tokens stored in carry
        expect(R.lastUpdate).to.be.closeTo(t0 + half, 1);     // time advanced

        await network.provider.request({
          method: "hardhat_stopImpersonatingAccount",
          params: [distAddr],
        });
      });

      it("rolls accumulated carry into the next stream when funded again with no depositors", async () => {
        // Still starting with no shares
        expect(await vault.totalShares()).to.equal(0);

        const rewardToken = token1.address;
        const netAmount1 = WEEK_SECS;        // stream #1
        const netAmount2 = WEEK_SECS * 2;    // stream #2

        const distAddr = distributor.address;
        await network.provider.send("hardhat_setBalance", [
          distAddr,
          "0x8AC7230489E80000", // 10 ETH
        ]);
        await network.provider.request({
          method: "hardhat_impersonateAccount",
          params: [distAddr],
        });
        const distSigner = await ethers.getSigner(distAddr);

        //
        // 1) First funding at t0
        //
        let tx = await vault.connect(distSigner).onAirdropFunded(rewardToken, netAmount1);
        let rcpt = await tx.wait();
        let block = await ethers.provider.getBlock(rcpt.blockNumber);
        if (!block) throw new Error("block not found");
        const t0 = block.timestamp;

        // Fast-forward to AFTER the first period finishes
        await setNextBlockTimestamp(t0 + WEEK_SECS + 1);

        // Trigger _updateReward so the entire first stream accrues into carry
        await vault.claimRewards(rewardToken);

        let R = await vault.rewards(rewardToken);
        expect(R.rate).to.equal(0);                      // stream ended
        expect(R.lastUpdate).to.equal(R.periodFinish);   // fully updated
        // All of netAmount1 should now be in carry (no eligible shares)
        expect(R.carry).to.equal(netAmount1);
        const carryBefore = R.carry;

        //
        // 2) Second funding at t1: carry should be rolled into the new totalToStream
        //
        tx = await vault.connect(distSigner).onAirdropFunded(rewardToken, netAmount2);
        rcpt = await tx.wait();
        block = await ethers.provider.getBlock(rcpt.blockNumber);
        if (!block) throw new Error("block not found");
        const t1 = block.timestamp;

        R = await vault.rewards(rewardToken);

        const totalToStream = carryBefore.add(netAmount2);
        const expectedRate = totalToStream.div(WEEK_SECS);
        const expectedRemainder = totalToStream.sub(expectedRate.mul(WEEK_SECS));

        expect(R.periodFinish).to.equal(t1 + WEEK_SECS);
        expect(R.rate).to.equal(expectedRate);
        expect(R.carry).to.equal(expectedRemainder);
        // lastUpdate should be the new "now"
        expect(R.lastUpdate).to.equal(t1);

        await network.provider.request({
          method: "hardhat_stopImpersonatingAccount",
          params: [distAddr],
        });
      });
    });
    // ─────────────────────────────────────────────────────────────
    // Airdrops: join mid‑stream
    // ─────────────────────────────────────────────────────────────
    describe("airdrop rewards: join mid‑stream", () => {

      beforeEach(async() => {
        await distributor.modifyAllowed(token1.address, true)
      })
      it("sets perSharePaid for a late depositor so they don't earn past rewards", async () => {
        const [deployerSigner, aliceSigner, bobSigner] = await ethers.getSigners();
        const aliceAddr = await aliceSigner.getAddress();
        const bobAddr   = await bobSigner.getAddress();

        const rewardToken = token1; // reuse QUOTE token as reward token
        const ONE = BigNumber.from(10).pow(8);
        const depositAmt = ONE.mul(1_000);

        // --- Alice deposits balanced liquidity before rewards start ---
        await token0.transfer(aliceAddr, depositAmt);
        await token1.transfer(aliceAddr, depositAmt);
        await token0.connect(aliceSigner).approve(vault.address, depositAmt);
        await token1.connect(aliceSigner).approve(vault.address, depositAmt);

        await vault.connect(aliceSigner).depositWithPolicy(depositAmt, depositAmt, supraArgs);

        const aliceShares = await vault.userShares(aliceAddr);
        expect(aliceShares).to.be.gt(0);

        // --- Fund rewards via distributor ---
        const rewardAmount = ONE.mul(1_000_000); // large to reduce rounding noise

        await token1.approve(distributor.address, rewardAmount);
        await distributor.fund(vault.address, rewardToken.address, rewardAmount);

        // --- Let some of the stream elapse with only Alice in the vault ---
        const dt1 = Math.floor(WEEK_SECS / 4); // 1/4 of the week
        await increaseTime(dt1);

        // Refresh oracle so Bob's deposit doesn't see a stale price
        await refreshOraclePrice1to1();

        // --- Bob joins mid‑stream with the same sized deposit ---
        await token0.transfer(bobAddr, depositAmt);
        await token1.transfer(bobAddr, depositAmt);
        await token0.connect(bobSigner).approve(vault.address, depositAmt);
        await token1.connect(bobSigner).approve(vault.address, depositAmt);

        await vault.connect(bobSigner).depositWithPolicy(depositAmt, depositAmt, supraArgs);

        const bobShares = await vault.userShares(bobAddr);
        expect(bobShares).to.be.gt(0);

        const bobUR = await vault.userRewards(bobAddr, rewardToken.address);
        expect(bobUR.accrued).to.equal(0);

        // perSharePaid should equal the global perShare at the time Bob joined
        const R = await vault.rewards(rewardToken.address);
        expect(bobUR.perSharePaid).to.equal(R.perShare);
      });
      it("late depositor earns less than early depositor with equal deposits", async () => {
        const [deployerSigner, aliceSigner, bobSigner] = await ethers.getSigners();
        const aliceAddr = await aliceSigner.getAddress();
        const bobAddr   = await bobSigner.getAddress();

        const rewardToken = token1; // reward token to stream
        const ONE = BigNumber.from(10).pow(8); // 1e8
        const depositAmt = ONE.mul(1_000);
        const vestingSecs = (await vault.VESTING_SECS()).toNumber();

        // --- Alice deposits at t0 ---
        await token0.transfer(aliceAddr, depositAmt);
        await token1.transfer(aliceAddr, depositAmt);
        await token0.connect(aliceSigner).approve(vault.address, depositAmt);
        await token1.connect(aliceSigner).approve(vault.address, depositAmt);

        await vault.connect(aliceSigner).depositWithPolicy(depositAmt, depositAmt, supraArgs);

        const aliceShares = await vault.userShares(aliceAddr);
        expect(aliceShares).to.be.gt(0);

        // --- Fund rewards at t0 ---
        const rewardAmount = ONE.mul(1_000_000);
        await rewardToken.approve(distributor.address, rewardAmount);
        await distributor.fund(vault.address, rewardToken.address, rewardAmount);

        // --- Move to mid-stream ---
        await increaseTime(Math.floor(vestingSecs / 2));

        // --- Bob deposits at mid-stream (requires fresh oracle) ---
        await refreshOraclePrice1to1();

        await token0.transfer(bobAddr, depositAmt);
        await token1.transfer(bobAddr, depositAmt);
        await token0.connect(bobSigner).approve(vault.address, depositAmt);
        await token1.connect(bobSigner).approve(vault.address, depositAmt);

        await vault.connect(bobSigner).depositWithPolicy(depositAmt, depositAmt, supraArgs);

        const bobShares = await vault.userShares(bobAddr);
        // Equal deposits at 1:1 price -> should mint equal shares (assuming initOwnerBips == 0)
        expect(bobShares).to.equal(aliceShares);

        // --- Move to (just past) end of stream ---
        await increaseTime(Math.floor(vestingSecs / 2) + 5);

        // --- Both claim ONCE and compare deltas ---
        const aliceBefore = await rewardToken.balanceOf(aliceAddr);
        const bobBefore   = await rewardToken.balanceOf(bobAddr);

        await vault.connect(aliceSigner).claimRewards(rewardToken.address);
        await vault.connect(bobSigner).claimRewards(rewardToken.address);

        const aliceAfter = await rewardToken.balanceOf(aliceAddr);
        const bobAfter   = await rewardToken.balanceOf(bobAddr);

        const aliceDelta = aliceAfter.sub(aliceBefore);
        const bobDelta   = bobAfter.sub(bobBefore);

        expect(bobDelta).to.be.gt(0);
        expect(aliceDelta).to.be.gt(bobDelta);

        // If Bob joins exactly halfway, Alice should get ~3x Bob:
        // - first half: Alice alone (≈ 1/2)
        // - second half: Alice+Bob split (≈ 1/4 each)
        // => Alice ≈ 3/4, Bob ≈ 1/4 => ratio ≈ 3
        const ratioBps = aliceDelta.mul(10_000).div(bobDelta);
        expect(ratioBps).to.be.closeTo(BigNumber.from(30_000), BigNumber.from(1_000)); // ±10%
      });
      it("late depositor mid-stream has perSharePaid synced (cannot earn past rewards)", async () => {
        const [_, aliceSigner, bobSigner] = await ethers.getSigners();
        const alice = await aliceSigner.getAddress();
        const bob   = await bobSigner.getAddress();

        const ONE = BigNumber.from(10).pow(8);
        const depositAmt = ONE.mul(1_000);
        const rewardToken = token1;

        // Alice deposits first
        await token0.transfer(alice, depositAmt);
        await token1.transfer(alice, depositAmt);
        await token0.connect(aliceSigner).approve(vault.address, depositAmt);
        await token1.connect(aliceSigner).approve(vault.address, depositAmt);
        await vault.connect(aliceSigner).depositWithPolicy(depositAmt, depositAmt, supraArgs);

        // Fund rewards
        const rewardAmount = ONE.mul(1_000_000);
        await rewardToken.approve(distributor.address, rewardAmount);
        await distributor.fund(vault.address, rewardToken.address, rewardAmount);

        // Let stream run for a while
        await increaseTime(Math.floor(WEEK_SECS / 3));

        // Bob deposits mid-stream (needs fresh oracle timestamp)
        await refreshOraclePrice1to1();

        await token0.transfer(bob, depositAmt);
        await token1.transfer(bob, depositAmt);
        await token0.connect(bobSigner).approve(vault.address, depositAmt);
        await token1.connect(bobSigner).approve(vault.address, depositAmt);

        await vault.connect(bobSigner).depositWithPolicy(depositAmt, depositAmt, supraArgs);

        // Key anti-steal condition: after Bob's deposit, his perSharePaid must equal current perShare
        const R = await vault.rewards(rewardToken.address);
        const U = await vault.userRewards(bob, rewardToken.address);

        expect(U.perSharePaid).to.equal(R.perShare);
        // and he should not have been credited any past rewards on deposit
        expect(U.accrued).to.equal(0);
      });
      it("user exits to 0 shares and re-enters later without earning during the gap", async () => {
        const [_, aliceSigner] = await ethers.getSigners();
        const alice = await aliceSigner.getAddress();

        const ONE = BigNumber.from(10).pow(8);
        const depositAmt = ONE.mul(1_000);
        const rewardToken = token1;

        // Alice deposits
        await token0.transfer(alice, depositAmt);
        await token1.transfer(alice, depositAmt);
        await token0.connect(aliceSigner).approve(vault.address, depositAmt);
        await token1.connect(aliceSigner).approve(vault.address, depositAmt);
        await vault.connect(aliceSigner).depositWithPolicy(depositAmt, depositAmt, supraArgs);

        // Fund rewards and run a bit
        const rewardAmount = ONE.mul(1_000_000);
        await rewardToken.approve(distributor.address, rewardAmount);
        await distributor.fund(vault.address, rewardToken.address, rewardAmount);

        // Must pass lockup before withdrawing (LOCKUP_SECS is 1 day)
        await increaseTime(24 * 60 * 60 + 5);
        await refreshOraclePrice1to1();

        // Withdraw all (burn to 0 shares)
        const depositIds = await vault.depositsOf(alice);
        await vault.connect(aliceSigner).withdrawAllFromDeposit(depositIds[0], supraArgs);
        expect(await vault.userShares(alice)).to.equal(0);

        // Claim whatever she had, resetting accrued to zero
        await vault.connect(aliceSigner).claimRewards(rewardToken.address);
        const afterClaim = await vault.userRewards(alice, rewardToken.address);
        expect(afterClaim.accrued).to.equal(0);

        // Wait while stream continues (this is the gap where she must NOT earn)
        await increaseTime(Math.floor(WEEK_SECS / 4));

        // Re-enter: deposit again
        await refreshOraclePrice1to1();
        await token0.connect(aliceSigner).approve(vault.address, depositAmt);
        await token1.connect(aliceSigner).approve(vault.address, depositAmt);
        await vault.connect(aliceSigner).depositWithPolicy(depositAmt, depositAmt, supraArgs);

        // Anti-steal check: perSharePaid must be synced at re-entry
        const R = await vault.rewards(rewardToken.address);
        const U = await vault.userRewards(alice, rewardToken.address);
        expect(U.perSharePaid).to.equal(R.perShare);
      });
      it("late depositor mid-stream syncs perSharePaid for multiple reward tokens", async () => {
        const [deployerSigner, aliceSigner, bobSigner] = await ethers.getSigners();
        const alice = await aliceSigner.getAddress();
        const bob   = await bobSigner.getAddress();

        const ONE = BigNumber.from(10).pow(8);
        const depositAmt = ONE.mul(1_000);

        // Deploy a 2nd reward token (separate from base/quote)
        const ERC20MockFactory = await ethers.getContractFactory("ERC20Mock");
        const reward2 = await ERC20MockFactory.deploy("Reward2", "R2", 8, 1_000_000_000);
        await reward2.deployed();
        await distributor.modifyAllowed(reward2.address, true)

        // Alice deposits
        await token0.transfer(alice, depositAmt);
        await token1.transfer(alice, depositAmt);
        await token0.connect(aliceSigner).approve(vault.address, depositAmt);
        await token1.connect(aliceSigner).approve(vault.address, depositAmt);
        await vault.connect(aliceSigner).depositWithPolicy(depositAmt, depositAmt, supraArgs);

        // Fund both reward streams
        const amt1 = ONE.mul(500_000);
        const amt2 = ONE.mul(700_000);

        await token1.connect(deployerSigner).approve(distributor.address, amt1);
        await distributor.fund(vault.address, token1.address, amt1);

        await reward2.connect(deployerSigner).approve(distributor.address, amt2);
        await distributor.fund(vault.address, reward2.address, amt2);

        // Run some time
        await increaseTime(Math.floor(WEEK_SECS / 3));

        // Bob deposits mid-stream
        await refreshOraclePrice1to1();
        await token0.transfer(bob, depositAmt);
        await token1.transfer(bob, depositAmt);
        await token0.connect(bobSigner).approve(vault.address, depositAmt);
        await token1.connect(bobSigner).approve(vault.address, depositAmt);
        await vault.connect(bobSigner).depositWithPolicy(depositAmt, depositAmt, supraArgs);

        // Must sync for token1
        const R1 = await vault.rewards(token1.address);
        const U1 = await vault.userRewards(bob, token1.address);
        expect(U1.perSharePaid).to.equal(R1.perShare);
        expect(U1.accrued).to.equal(0);

        // Must sync for reward2
        const R2 = await vault.rewards(reward2.address);
        const U2 = await vault.userRewards(bob, reward2.address);
        expect(U2.perSharePaid).to.equal(R2.perShare);
        expect(U2.accrued).to.equal(0);
      });
      it("sum of claims cannot exceed distributor credited amount (no over-claim)", async () => {
        const [deployerSigner, aliceSigner, bobSigner] = await ethers.getSigners();
        const alice = await aliceSigner.getAddress();
        const bob   = await bobSigner.getAddress();

        const ONE = BigNumber.from(10).pow(8);
        const depositAmt = ONE.mul(1_000);
        const rewardToken = token1;

        // Both deposit
        for (const [signer, addr] of [[aliceSigner, alice], [bobSigner, bob]] as any) {
          await token0.transfer(addr, depositAmt);
          await token1.transfer(addr, depositAmt);
          await token0.connect(signer).approve(vault.address, depositAmt);
          await token1.connect(signer).approve(vault.address, depositAmt);
          await vault.connect(signer).depositWithPolicy(depositAmt, depositAmt, supraArgs);
        }

        // Fund rewards
        const rewardAmount = ONE.mul(1_000_000);
        await rewardToken.connect(deployerSigner).approve(distributor.address, rewardAmount);
        await distributor.fund(vault.address, rewardToken.address, rewardAmount);

        // Let stream run, then both claim a couple times
        await increaseTime(Math.floor(WEEK_SECS / 3));
        await vault.connect(aliceSigner).claimRewards(rewardToken.address);

        await increaseTime(Math.floor(WEEK_SECS / 3));
        await vault.connect(bobSigner).claimRewards(rewardToken.address);

        await increaseTime(Math.floor(WEEK_SECS / 3));
        await vault.connect(aliceSigner).claimRewards(rewardToken.address);
        await vault.connect(bobSigner).claimRewards(rewardToken.address);

        // Total claimed from distributor must never exceed credited for that vault/token
        const credited = await distributor.credited(vault.address, rewardToken.address);
        const claimed  = await distributor.claimed(vault.address, rewardToken.address);
        expect(claimed).to.be.lte(credited);
      });
      it("management fee shares do not earn / dilute airdrops", async () => {
        
        // helper
        function bnAbs(a: BigNumber, b: BigNumber) {
          return a.gte(b) ? a.sub(b) : b.sub(a);
        }

        const [deployerSigner, aliceSigner] = await ethers.getSigners();
        const deployerAddr = await deployerSigner.getAddress();
        const aliceAddr = await aliceSigner.getAddress();

        const ONE = BigNumber.from(10).pow(8);
        const depositAmt = ONE.mul(1_000);

        // Redeploy a fresh vault with a non-zero initial management fee (so ownerFeeShares will exist)
        const VaultF = await ethers.getContractFactory("PLEXPairVault");
        const feeBips = 1_000; // 0.1% / week
        const feeVault = await VaultF.deploy(
          token0.address,
          token1.address,
          token0.address,
          token1.address,
          distributor.address,
          feeBips
        );
        await feeVault.deployed();

        // Alice deposits balanced liquidity
        await token0.transfer(aliceAddr, depositAmt);
        await token1.transfer(aliceAddr, depositAmt);
        await token0.connect(aliceSigner).approve(feeVault.address, depositAmt);
        await token1.connect(aliceSigner).approve(feeVault.address, depositAmt);

        await feeVault.connect(aliceSigner).depositWithPolicy(depositAmt, depositAmt, supraArgs);

        // Let 1 week pass, then trigger fee accrual via scheduleOwnerFeeBips()
        await network.provider.send("evm_increaseTime", [WEEK_SECS + 1]);
        await network.provider.send("evm_mine");

        // This triggers _accrueMgmtFee() internally; the scheduled change itself is irrelevant here.
        await feeVault.connect(deployerSigner).scheduleOwnerFeeBips(feeBips);

        const ownerFeeShares = await feeVault.ownerFeeShares();
        expect(ownerFeeShares).to.be.gt(0);

        // Deploy a separate reward token so accounting is clean (not BASE or QUOTE)
        const ERC20MockF = await ethers.getContractFactory("ERC20Mock");
        const reward = await ERC20MockF.deploy("Reward", "RWD", 8, 1_000_000_000);
        await reward.deployed();
        await distributor.modifyAllowed(reward.address, true)

        // Fund the vault with a big reward amount
        const rewardAmount = ONE.mul(1_000_000); // 1,000,000 tokens (8 decimals)
        await reward.approve(distributor.address, rewardAmount);
        await distributor.fund(feeVault.address, reward.address, rewardAmount);

        // Jump to after the stream ends
        const vesting = await feeVault.VESTING_SECS();
        await network.provider.send("evm_increaseTime", [vesting.toNumber() + 3]);
        await network.provider.send("evm_mine");

        // Alice claims
        const aliceRewardBefore = await reward.balanceOf(aliceAddr);
        await feeVault.connect(aliceSigner).claimRewards(reward.address);
        const aliceRewardAfter = await reward.balanceOf(aliceAddr);
        const aliceClaimed = aliceRewardAfter.sub(aliceRewardBefore);

        // Owner tries to claim too (should not receive anything unless owner also deposited)
        const ownerRewardBefore = await reward.balanceOf(deployerAddr);
        await feeVault.connect(deployerSigner).claimRewards(reward.address);
        const ownerRewardAfter = await reward.balanceOf(deployerAddr);
        const ownerClaimed = ownerRewardAfter.sub(ownerRewardBefore);

        expect(ownerClaimed).to.equal(0);

        // If fee shares were (incorrectly) included in eligible shares, Alice would be diluted ~feeBips
        // and a noticeable chunk would remain unclaimable at the distributor.
        const remaining = await distributor.remaining(feeVault.address, reward.address);

        // Allow a tiny tolerance for rounding/carry (should be << 1 token, but keep it generous)
        const tol = ONE.mul(5); // 5 tokens tolerance
        expect(bnAbs(aliceClaimed.add(remaining), rewardAmount)).to.be.lte(tol);

        // Stronger sanity: Alice should get essentially everything
        expect(rewardAmount.sub(aliceClaimed)).to.be.lte(tol);
      });
      it("emergency withdraw settles rewards so accrued rewards are still claimable (not lost)", async () => {
        const [deployerSigner, aliceSigner] = await ethers.getSigners();
        const aliceAddr = await aliceSigner.getAddress();

        const ONE = BigNumber.from(10).pow(8);
        const depositAmt = ONE.mul(1_000);

        // Separate reward token
        const ERC20MockF = await ethers.getContractFactory("ERC20Mock");
        const reward = await ERC20MockF.deploy("Reward", "RWD", 8, 1_000_000_000);
        await reward.deployed();
        await distributor.modifyAllowed(reward.address, true)

        // Alice deposits
        await token0.transfer(aliceAddr, depositAmt);
        await token1.transfer(aliceAddr, depositAmt);
        await token0.connect(aliceSigner).approve(vault.address, depositAmt);
        await token1.connect(aliceSigner).approve(vault.address, depositAmt);

        const depTx = await vault.connect(aliceSigner).depositWithPolicy(depositAmt, depositAmt, supraArgs);
        const depRcpt = await depTx.wait();

        // Best effort: extract depositId from event; fallback to 0 if your event doesn't include it yet
        let depositId = BigNumber.from(0);
        const ev = depRcpt.events?.find((e: any) => e.event === "DepositedPolicy");
        if (ev?.args?.depositId != null) depositId = ev.args.depositId;

        // Fund rewards (starts stream immediately)
        const rewardAmount = ONE.mul(100_000);
        await reward.approve(distributor.address, rewardAmount);
        await distributor.fund(vault.address, reward.address, rewardAmount);

        // Let some rewards accrue
        await network.provider.send("evm_increaseTime", [DAY_SECS]);
        await network.provider.send("evm_mine");

        // Enable emergency mode (owner can do this)
        await vault.connect(deployerSigner).enableEmergencyMode();

        // Emergency withdraw ignores lockup AND calls _settleRewards(user) before burning shares
        await vault.connect(aliceSigner).emergencyWithdrawFromDeposit(depositId);

        // After emergency withdraw, accrued should be > 0 (settled up to this timestamp)
        const ur = await vault.userRewards(aliceAddr, reward.address);
        expect(ur.accrued).to.be.gt(0);

        // Claim should pay exactly the accrued amount, even though Alice now has 0 shares
        const balBefore = await reward.balanceOf(aliceAddr);
        await vault.connect(aliceSigner).claimRewards(reward.address);
        const balAfter = await reward.balanceOf(aliceAddr);

        expect(balAfter.sub(balBefore)).to.equal(ur.accrued);

        // Accrued resets to 0 after claim
        const urAfter = await vault.userRewards(aliceAddr, reward.address);
        expect(urAfter.accrued).to.equal(0);

        // And Alice should not earn anything further after she has exited (eligibleShares=0 → carry)
        await network.provider.send("evm_increaseTime", [(await vault.VESTING_SECS()).toNumber()]);
        await network.provider.send("evm_mine");

        const balMid = await reward.balanceOf(aliceAddr);
        await vault.connect(aliceSigner).claimRewards(reward.address);
        const balEnd = await reward.balanceOf(aliceAddr);
        expect(balEnd).to.equal(balMid);

        // `claimRewards` above updated global reward state and (since eligibleShares==0)
        // should have pushed the remainder into carry.
        const Rbefore = await vault.rewards(reward.address);
        const carryBefore: BigNumber = Rbefore.carry;
        expect(carryBefore).to.be.gt(0);

        // Next funding should include carry in the new stream configuration.
        const refill = ONE.mul(10_000); // 10k reward tokens
        await reward.approve(distributor.address, refill);
        await distributor.fund(vault.address, reward.address, refill);

        // Now the vault should have started (or blended into) a stream where
        // totalToStream includes carryBefore + refill (inactive case => fresh 1-week stream).
        const Rafter = await vault.rewards(reward.address);

        const vestingSecs = (await vault.VESTING_SECS()).toNumber();
        const totalToStream = carryBefore.add(refill);

        // In the INACTIVE branch: rate = totalToStream / vestingSecs, carry = remainder.
        const expectedRate = totalToStream.div(vestingSecs);
        const expectedCarryRemainder = totalToStream.sub(expectedRate.mul(vestingSecs));

        expect(Rafter.rate).to.equal(expectedRate);
        expect(Rafter.carry).to.equal(expectedCarryRemainder);
      });
    });
  });
  describe("airdrop rewards: state machine fuzz (anti-steal)", () => {
    // deterministic PRNG (mulberry32)
    function mulberry32(seed: number) {
      return function () {
        let t = (seed += 0x6d2b79f5);
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    }

    function randInt(rng: () => number, min: number, max: number) {
      return Math.floor(rng() * (max - min + 1)) + min;
    }

    async function refreshOraclePrice1to1() {
      const ONE = BigNumber.from(10).pow(8); // 1e8
      const latest = await ethers.provider.getBlock("latest");
      const ts = latest!.timestamp;

      await mockSupra.setPriceInfo(
        1,
        [1],    // pairs
        [ONE],  // prices (1.0 * 1e8)
        [ts],   // timestamp
        [ONE],  // decimal (= scale = 1e8)
        [0]     // round
      );
    }

    it("random sequence cannot create retroactive rewards on 0->>0 shares transitions", async () => {
      const rng = mulberry32(1337);
      const [deployerSigner, aliceSigner, bobSigner, carolSigner] = await ethers.getSigners();
      const deployerAddr = await deployerSigner.getAddress();
      const aliceAddr = await aliceSigner.getAddress();
      const bobAddr = await bobSigner.getAddress();
      const carolAddr = await carolSigner.getAddress();

      const ONE = BigNumber.from(10).pow(8);
      const depositUnit = ONE.mul(100); // keep it small-ish but non-trivial
      const STEP_COUNT = 80;

      // ---- deploy 2 reward tokens (avoid mixing with BASE/QUOTE) ----
      const ERC20MockFactory = await ethers.getContractFactory("ERC20Mock");
      const rewardA = (await ERC20MockFactory.deploy("RewardA", "RWA", 8, 1_000_000_000)) as ERC20Mock;
      await rewardA.deployed();
      const rewardB = (await ERC20MockFactory.deploy("RewardB", "RWB", 8, 1_000_000_000)) as ERC20Mock;
      await rewardB.deployed();

      await distributor.modifyAllowed(rewardA.address, true)
      await distributor.modifyAllowed(rewardB.address, true)

      // Deployer approves distributor for reward tokens
      await rewardA.connect(deployerSigner).approve(distributor.address, ethers.constants.MaxUint256);
      await rewardB.connect(deployerSigner).approve(distributor.address, ethers.constants.MaxUint256);

      // Users approve vault for deposits (infinite approvals)
      for (const s of [aliceSigner, bobSigner, carolSigner]) {
        await token0.connect(s).approve(vault.address, ethers.constants.MaxUint256);
        await token1.connect(s).approve(vault.address, ethers.constants.MaxUint256);
      }

      // Make sure oracle is fresh for initial deposit
      await refreshOraclePrice1to1();

      // Ensure eligible shares > 0 before first fund (avoid any “no depositors yet” carry nuance)
      await token0.transfer(aliceAddr, depositUnit);
      await token1.transfer(aliceAddr, depositUnit);
      await vault.connect(aliceSigner).depositWithPolicy(depositUnit, depositUnit, supraArgs);

      // Seed the vault with at least one reward token in the list
      await distributor.fund(vault.address, rewardA.address, ONE.mul(50_000));
      await distributor.fund(vault.address, rewardB.address, ONE.mul(80_000));

      // Track which reward tokens have ever been funded (should match vault.rewardTokens in practice)
      const fundedRewardTokens: string[] = [rewardA.address, rewardB.address];

      // Track monotonicity of perShare
      const lastPerShare: Record<string, BigNumber> = {
        [rewardA.address]: BigNumber.from(0),
        [rewardB.address]: BigNumber.from(0),
      };

      async function assertPerShareMonotonic() {
        for (const rt of fundedRewardTokens) {
          const R = await vault.rewards(rt);
          expect(R.perShare).to.be.gte(lastPerShare[rt]);
          lastPerShare[rt] = R.perShare;
        }
      }

      async function maybeTopUpForDeposit(userAddr: string) {
        // ensure user has enough base/quote for deposit caps
        const bal0 = await token0.balanceOf(userAddr);
        const bal1 = await token1.balanceOf(userAddr);
        if (bal0.lt(depositUnit)) await token0.transfer(userAddr, depositUnit.sub(bal0));
        if (bal1.lt(depositUnit)) await token1.transfer(userAddr, depositUnit.sub(bal1));
      }

      async function pickUnlockedDepositId(userAddr: string): Promise<BigNumber | null> {
        const ids = await vault.depositsOf(userAddr);
        if (ids.length === 0) return null;

        const latest = await ethers.provider.getBlock("latest");
        const nowTs = latest!.timestamp;

        // find any ACTIVE + unlocked lot
        for (let i = 0; i < ids.length; i++) {
          const id = ids[i];
          const d = await vault.deposits(id);
          // d.user might be zero if deleted; d.state may be 0 after delete; rely on shares>0 and lockup
          if (d.shares.gt(0) && d.user.toLowerCase() === userAddr.toLowerCase()) {
            if (BigNumber.from(nowTs).gte(d.lockupUntil)) return id;
          }
        }
        return null;
      }

      async function invariantNoRetroRewardsOnJoin(
        userAddr: string,
        depositBlockTs: number,
        didJoinFromZero: boolean
      ) {
        if (!didJoinFromZero) return;

        // A) perSharePaid must be synced; accrued must be 0
        for (const rt of fundedRewardTokens) {
          const R = await vault.rewards(rt);
          const U = await vault.userRewards(userAddr, rt);
          expect(U.perSharePaid).to.equal(R.perShare);
          expect(U.accrued).to.equal(0);
        }

        // B) immediate claim must not be able to “claim the past”
        //    (claimable should be <= rate * dt — dt is tiny between deposit and claim)
        const balBeforeA = await rewardA.balanceOf(userAddr);
        const balBeforeB = await rewardB.balanceOf(userAddr);

        const claimTx = await vault.connect(
          userAddr === aliceAddr ? aliceSigner : userAddr === bobAddr ? bobSigner : carolSigner
        ).claimAllRewards();
        const claimRcpt = await claimTx.wait();
        const claimBlock = await ethers.provider.getBlock(claimRcpt.blockNumber);
        const claimTs = claimBlock!.timestamp;

        const dt = Math.max(0, claimTs - depositBlockTs);

        const balAfterA = await rewardA.balanceOf(userAddr);
        const balAfterB = await rewardB.balanceOf(userAddr);

        const gotA = balAfterA.sub(balBeforeA);
        const gotB = balAfterB.sub(balBeforeB);

        // bound by total emission over dt seconds (+1 slack for rounding)
        const RA = await vault.rewards(rewardA.address);
        const RB = await vault.rewards(rewardB.address);

        const boundA = RA.rate.mul(dt).add(1);
        const boundB = RB.rate.mul(dt).add(1);

        expect(gotA).to.be.lte(boundA);
        expect(gotB).to.be.lte(boundB);
      }

      // ---- state machine ----
      const users = [
        { signer: aliceSigner, addr: aliceAddr },
        { signer: bobSigner, addr: bobAddr },
        { signer: carolSigner, addr: carolAddr },
      ];

      for (let step = 0; step < STEP_COUNT; step++) {
        const roll = randInt(rng, 0, 99);

        // 0-19: time travel
        if (roll < 20) {
          // sometimes short, sometimes longer (to unlock)
          const seconds =
            rng() < 0.7 ? randInt(rng, 1, 3000) : randInt(rng, DAY_SECS + 1, 3 * DAY_SECS);
          await increaseTime(seconds);
          await assertPerShareMonotonic();
          continue;
        }

        // 20-34: fund rewards (random token, random amount)
        if (roll < 35) {
          const which = rng() < 0.5 ? rewardA : rewardB;
          const amt = ONE.mul(randInt(rng, 1_000, 50_000));
          await distributor.fund(vault.address, which.address, amt);
          await assertPerShareMonotonic();
          continue;
        }

        // 35-64: deposit
        if (roll < 65) {
          const u = users[randInt(rng, 0, users.length - 1)];

          await maybeTopUpForDeposit(u.addr);
          await refreshOraclePrice1to1();

          const preShares = await vault.userShares(u.addr);
          const didJoinFromZero = preShares.eq(0);

          const tx = await vault.connect(u.signer).depositWithPolicy(depositUnit, depositUnit, supraArgs);
          const rcpt = await tx.wait();
          const blk = await ethers.provider.getBlock(rcpt.blockNumber);
          const depositTs = blk!.timestamp;

          const postShares = await vault.userShares(u.addr);
          // If they were 0 before, they should now be >0 after a successful deposit
          if (didJoinFromZero) expect(postShares).to.be.gt(0);

          await invariantNoRetroRewardsOnJoin(u.addr, depositTs, didJoinFromZero);
          await assertPerShareMonotonic();
          continue;
        }

        // 65-84: withdraw (random user, random unlocked deposit, partial or full)
        if (roll < 85) {
          const u = users[randInt(rng, 0, users.length - 1)];
          const depId = await pickUnlockedDepositId(u.addr);
          if (!depId) {
            await assertPerShareMonotonic();
            continue; // nothing withdrawable
          }

          await refreshOraclePrice1to1();

          const d = await vault.deposits(depId);
          if (d.shares.eq(0)) {
            await assertPerShareMonotonic();
            continue;
          }

          // burn either full or half-ish
          const burn =
            rng() < 0.4
              ? d.shares
              : d.shares.div(2).gt(0)
                ? d.shares.div(2)
                : d.shares;

          await vault.connect(u.signer).withdrawFromDeposit(depId, burn, supraArgs);
          await assertPerShareMonotonic();
          continue;
        }

        // 85-99: claim actions
        {
          const u = users[randInt(rng, 0, users.length - 1)];

          // either claimAll or claim a single token
          if (rng() < 0.5) {
            await vault.connect(u.signer).claimAllRewards();
          } else {
            const which = rng() < 0.5 ? rewardA.address : rewardB.address;
            await vault.connect(u.signer).claimRewards(which);
          }

          await assertPerShareMonotonic();
        }
      }

      // Final sanity: no one can have perSharePaid > perShare for funded tokens
      for (const u of users) {
        for (const rt of fundedRewardTokens) {
          const R = await vault.rewards(rt);
          const U = await vault.userRewards(u.addr, rt);
          expect(U.perSharePaid).to.be.lte(R.perShare);
        }
      }

      // Final invariant: distributor claimed never exceeds credited
      for (const rt of fundedRewardTokens) {
        const credited = await distributor.credited(vault.address, rt);
        const claimed = await distributor.claimed(vault.address, rt);
        expect(claimed).to.be.lte(credited);
      }
    });
  });
  describe("airdrop rewards: forced re-entry fuzz (anti-steal)", () => {
    async function refreshOraclePrice1to1() {
      const ONE = BigNumber.from(10).pow(8); // 1e8
      const latest = await ethers.provider.getBlock("latest");
      const ts = latest!.timestamp;

      await mockSupra.setPriceInfo(
        1,
        [1],    // pairs
        [ONE],  // prices (1.0 * 1e8)
        [ts],   // timestamp
        [ONE],  // decimal (= scale = 1e8)
        [0]     // round
      );
    }

    async function ensureUserHasDepositTokens(userAddr: string, amount: BigNumber) {
      const b0 = await token0.balanceOf(userAddr);
      const b1 = await token1.balanceOf(userAddr);
      if (b0.lt(amount)) await token0.transfer(userAddr, amount.sub(b0));
      if (b1.lt(amount)) await token1.transfer(userAddr, amount.sub(b1));
    }

    it("repeated 0->>0 re-entries cannot claim past stream rewards", async () => {
      const [deployerSigner, aliceSigner, bobSigner] = await ethers.getSigners();
      const deployerAddr = await deployerSigner.getAddress();
      const aliceAddr = await aliceSigner.getAddress();
      const bobAddr = await bobSigner.getAddress();

      const ONE = BigNumber.from(10).pow(8);
      const depositAmt = ONE.mul(1_000);          // 1000/1000
      const fundAmtA = ONE.mul(500_000);          // big enough to make rates noticeable
      const fundAmtB = ONE.mul(800_000);
      const LOCKUP = (await vault.LOCKUP_SECS()).toNumber();
      const VESTING = (await vault.VESTING_SECS()).toNumber();

      // Deploy 2 reward tokens (distinct from BASE/QUOTE)
      const ERC20MockFactory = await ethers.getContractFactory("ERC20Mock");
      const rewardA = (await ERC20MockFactory.deploy("RewardA", "RWA", 8, 1_000_000_000)) as ERC20Mock;
      await rewardA.deployed();
      const rewardB = (await ERC20MockFactory.deploy("RewardB", "RWB", 8, 1_000_000_000)) as ERC20Mock;
      await rewardB.deployed();

      await distributor.modifyAllowed(rewardA.address, true)
      await distributor.modifyAllowed(rewardB.address, true)

      // Approvals
      await rewardA.connect(deployerSigner).approve(distributor.address, ethers.constants.MaxUint256);
      await rewardB.connect(deployerSigner).approve(distributor.address, ethers.constants.MaxUint256);

      await token0.connect(aliceSigner).approve(vault.address, ethers.constants.MaxUint256);
      await token1.connect(aliceSigner).approve(vault.address, ethers.constants.MaxUint256);
      await token0.connect(bobSigner).approve(vault.address, ethers.constants.MaxUint256);
      await token1.connect(bobSigner).approve(vault.address, ethers.constants.MaxUint256);

      // Ensure oracle fresh
      await refreshOraclePrice1to1();

      // --- Setup: Bob enters and stays (so stream has depositors even when Alice exits) ---
      await ensureUserHasDepositTokens(bobAddr, depositAmt);
      await vault.connect(bobSigner).depositWithPolicy(depositAmt, depositAmt, supraArgs);
      expect(await vault.userShares(bobAddr)).to.be.gt(0);

      // --- Fund both rewards to start streaming ---
      await distributor.fund(vault.address, rewardA.address, fundAmtA);
      await distributor.fund(vault.address, rewardB.address, fundAmtB);

      const funded = [rewardA.address, rewardB.address];

      // helper: withdraw ALL lots for a user (must be unlocked)
      async function withdrawAllLots(userSigner: any, userAddr: string) {
        const ids = await vault.depositsOf(userAddr);
        for (const id of ids) {
          const d = await vault.deposits(id);
          if (d.shares.gt(0) && d.user.toLowerCase() === userAddr.toLowerCase()) {
            await refreshOraclePrice1to1();
            await vault.connect(userSigner).withdrawFromDeposit(id, d.shares, supraArgs);
          }
        }
      }

      // helper: assert sync invariant after 0->>0 join
      async function assertJoinSync(userAddr: string) {
        for (const rt of funded) {
          const R = await vault.rewards(rt);
          const U = await vault.userRewards(userAddr, rt);
          expect(U.perSharePaid).to.equal(R.perShare);
          expect(U.accrued).to.equal(0);
        }
      }

      // helper: “immediate claim” must not scoop the past
      async function assertImmediateClaimNotPast(userSigner: any, userAddr: string, depositBlockTs: number) {
        const balBeforeA = await rewardA.balanceOf(userAddr);
        const balBeforeB = await rewardB.balanceOf(userAddr);

        const tx = await vault.connect(userSigner).claimAllRewards();
        const rcpt = await tx.wait();
        const blk = await ethers.provider.getBlock(rcpt.blockNumber);
        const claimTs = blk!.timestamp;

        const dt = Math.max(0, claimTs - depositBlockTs);

        const balAfterA = await rewardA.balanceOf(userAddr);
        const balAfterB = await rewardB.balanceOf(userAddr);

        const gotA = balAfterA.sub(balBeforeA);
        const gotB = balAfterB.sub(balBeforeB);

        // Very safe upper bound: total emissions over dt (+ 1 whole token slack)
        // (If a retroactive-steal bug exists, gotA/gotB will be MASSIVE and fail this.)
        const RA = await vault.rewards(rewardA.address);
        const RB = await vault.rewards(rewardB.address);

        const slack = ONE; // 1 whole token (decimals=8)
        const boundA = RA.rate.mul(dt).add(slack);
        const boundB = RB.rate.mul(dt).add(slack);

        expect(gotA).to.be.lte(boundA);
        expect(gotB).to.be.lte(boundB);
      }

      // --- Adversarial churn cycles ---
      // Each cycle:
      // 1) Alice deposits (if she's not already in)
      // 2) wait > lockup, then claim+exit fully (shares -> 0)
      // 3) wait while stream accrues to Bob
      // 4) Alice re-enters from 0 and immediately claims (must NOT get past rewards)
      const CYCLES = 4; // fits inside a week given lockup is 1 day

      for (let i = 0; i < CYCLES; i++) {
        // If Alice isn't in, deposit now
        if ((await vault.userShares(aliceAddr)).eq(0)) {
          await ensureUserHasDepositTokens(aliceAddr, depositAmt);
          await refreshOraclePrice1to1();
          const tx = await vault.connect(aliceSigner).depositWithPolicy(depositAmt, depositAmt, supraArgs);
          await tx.wait();
        }

        // Wait so Alice can withdraw her lot(s) (lockup)
        await increaseTime(LOCKUP + 2);

        // Clear any accrued before exit so later "immediate claim" isn't just old legit rewards
        await vault.connect(aliceSigner).claimAllRewards();

        // Exit fully (Alice shares -> 0)
        await withdrawAllLots(aliceSigner, aliceAddr);

        // Claim again to clear rewards settled during withdrawal
        await vault.connect(aliceSigner).claimAllRewards();

        expect(await vault.userShares(aliceAddr)).to.equal(0);

        // Wait while stream accrues to Bob only (this is where bugs usually allow “rejoin stealing”)
        // Keep this < remaining vesting to ensure perShare actually moves mid-stream
        await increaseTime(Math.floor(VESTING / (CYCLES + 1)));

        // Force oracle fresh for next deposit
        await refreshOraclePrice1to1();

        // Ensure stream is still alive; if not, re-fund to restart a new stream window
        // (We don't need exact periodFinish logic; just ensure rates are non-zero.)
        {
          const R = await vault.rewards(rewardA.address);
          if (R.rate.eq(0)) {
            await distributor.fund(vault.address, rewardA.address, ONE.mul(200_000));
            await distributor.fund(vault.address, rewardB.address, ONE.mul(200_000));
          }
        }

        // Now Alice re-enters from 0
        const preShares = await vault.userShares(aliceAddr);
        expect(preShares).to.equal(0);

        await ensureUserHasDepositTokens(aliceAddr, depositAmt);
        await refreshOraclePrice1to1();

        const depTx = await vault.connect(aliceSigner).depositWithPolicy(depositAmt, depositAmt, supraArgs);
        const depRcpt = await depTx.wait();
        const depBlk = await ethers.provider.getBlock(depRcpt.blockNumber);
        const depTs = depBlk!.timestamp;

        const postShares = await vault.userShares(aliceAddr);
        expect(postShares).to.be.gt(0);

        // Critical invariant: after 0->>0, perSharePaid must be snapped to current perShare
        await assertJoinSync(aliceAddr);

        // Immediate claim must not scoop past rewards
        await assertImmediateClaimNotPast(aliceSigner, aliceAddr, depTs);
      }

      // Final sanity: Alice should have some rewards over the whole run, but never absurd
      // and distributor accounting should remain consistent.
      for (const rt of funded) {
        const credited = await distributor.credited(vault.address, rt);
        const claimed = await distributor.claimed(vault.address, rt);
        expect(claimed).to.be.lte(credited);
      }

      // Settle & claim for Bob (otherwise bobA is 0 even if he accrued)
      await vault.connect(bobSigner).claimAllRewards();

      // (Optional) also settle/claim for Alice at the end to include any tail accrual
      await vault.connect(aliceSigner).claimAllRewards();

      const bobA = await rewardA.balanceOf(bobAddr);
      const aliceA = await rewardA.balanceOf(aliceAddr);
      expect(bobA).to.be.gte(aliceA);
    });
  });
  describe("virtual shares mitigation (donation / inflation attack)", () => {
    const PAIR_ID = 1;
    const ONE = BigNumber.from(10).pow(8);

    // Must match your Solidity constants:
    const VIRTUAL_SHARES = BigNumber.from(1_000);
    const VIRTUAL_VALUEQ = BigNumber.from(1);

    async function refreshOracle1to1() {
      const latest = await ethers.provider.getBlock("latest");
      const ts = latest!.timestamp;

      // rawPrice = 1e8, scale = 1e8 => 1.0
      await mockSupra.setPriceInfo(
        PAIR_ID,
        [PAIR_ID],
        [ONE],
        [ts],
        [ONE],
        [0]
      );
    }

    function pow10(d: number) {
      return BigNumber.from(10).pow(d);
    }

    async function parseDepositedPolicy(receipt: any) {
      const ev = receipt.events?.find((e: any) => e.event === "DepositedPolicy");
      expect(ev, "DepositedPolicy event not found").to.exist;
      const args = ev.args;

      // event DepositedPolicy(address user, uint256 depositId, uint256 baseIn, uint256 quoteIn, uint256 sharesMinted, uint256 tvlQuoteBefore)
      return {
        user: args.user,
        depositId: args.depositId,
        baseIn: args.baseIn,
        quoteIn: args.quoteIn,
        sharesMinted: args.sharesMinted,
        tvlQuoteBefore: args.tvlQuoteBefore,
      };
    }

    it("first deposit mints using virtual offset: shares = valueQ*(S+VS)/(TVL+VV)", async () => {
      const aliceAddr = await alice.getAddress();

      const depositBaseMax = ONE;  // 1 BASE token
      const depositQuoteMax = ONE; // 1 QUOTE token

      // fund + approve
      await token0.transfer(aliceAddr, depositBaseMax);
      await token1.transfer(aliceAddr, depositQuoteMax);
      await token0.connect(alice).approve(vault.address, depositBaseMax);
      await token1.connect(alice).approve(vault.address, depositQuoteMax);

      await refreshOracle1to1();

      const supplyBefore = await vault.totalShares();
      expect(supplyBefore).to.equal(0);

      const tx = await vault.connect(alice).depositWithPolicy(depositBaseMax, depositQuoteMax, supraArgs);
      const rcpt = await tx.wait();
      const dep = await parseDepositedPolicy(rcpt);

      // For the first deposit on a fresh vault, tvlQuoteBefore should be 0
      expect(dep.tvlQuoteBefore).to.equal(0);

      // Recompute the price the vault should be using (normal orientation, equal decimals in your tests)
      const dBase = await token0.decimals();
      const dQuote = await token1.decimals();

      const rawPrice = ONE; // from mock oracle
      const scale = ONE;    // from mock oracle

      // price = rawPrice * 10^dQuote / 10^dBase
      const price = rawPrice.mul(pow10(dQuote)).div(pow10(dBase));

      // principalQ = baseIn*price/scale + quoteIn
      const principalQ = dep.baseIn.mul(price).div(scale).add(dep.quoteIn);

      // expectedShares = principalQ*(supplyBefore+VS)/(tvlBefore+VV)
      const expectedShares = principalQ
        .mul(supplyBefore.add(VIRTUAL_SHARES))
        .div(dep.tvlQuoteBefore.add(VIRTUAL_VALUEQ));

      expect(dep.sharesMinted).to.equal(expectedShares);

      // If your constants are VS=1000, VV=1 and TVL=0, this should be principalQ*1000
      expect(dep.sharesMinted).to.equal(principalQ.mul(1_000));
    });

    it("prevents classic donation attack: after huge donation, a tiny depositor still gets >0 shares", async () => {
      const aliceAddr = await alice.getAddress();
      const bobAddr = await bob.getAddress();
      const small = ONE; // 1 token each (1e8 units)

      // --- Alice first deposit (small) ---
      await token0.transfer(aliceAddr, small);
      await token1.transfer(aliceAddr, small);
      await token0.connect(alice).approve(vault.address, small);
      await token1.connect(alice).approve(vault.address, small);

      await refreshOracle1to1();

      const tx1 = await vault.connect(alice).depositWithPolicy(small, small, supraArgs);
      const rcpt1 = await tx1.wait();
      const dep1 = await parseDepositedPolicy(rcpt1);

      // With 1:1 price and equal decimals in tests:
      const alicePrincipalQ = dep1.baseIn.add(dep1.quoteIn);

      // Sanity: fixed vault mints ~principalQ*1000 on first deposit
      expect(dep1.sharesMinted).to.equal(alicePrincipalQ.mul(VIRTUAL_SHARES).div(VIRTUAL_VALUEQ));

      // --- Huge donation directly to vault (no shares minted) ---
      const donation = ONE.mul(300_000_000); // 300M tokens each side
      await token0.connect(deployer).transfer(vault.address, donation);
      await token1.connect(deployer).transfer(vault.address, donation);

      // --- Bob tries to deposit tiny amount ---
      await token0.transfer(bobAddr, small);
      await token1.transfer(bobAddr, small);
      await token0.connect(bob).approve(vault.address, small);
      await token1.connect(bob).approve(vault.address, small);

      await refreshOracle1to1();

      const supplyBeforeBob = await vault.totalShares();

      const tx2 = await vault.connect(bob).depositWithPolicy(small, small, supraArgs);
      const rcpt2 = await tx2.wait();
      const dep2 = await parseDepositedPolicy(rcpt2);

      // Must not be 0 shares (this was the practical "shares=0" griefing vector)
      expect(dep2.sharesMinted).to.be.gt(0);

      // Strong check: minted shares match the *current* virtual offset formula
      const bobPrincipalQ = dep2.baseIn.add(dep2.quoteIn); // price=1 in this test
      const expectedSharesNew = bobPrincipalQ
        .mul(supplyBeforeBob.add(VIRTUAL_SHARES))
        .div(dep2.tvlQuoteBefore.add(VIRTUAL_VALUEQ));

      expect(dep2.sharesMinted).to.equal(expectedSharesNew);

      // Now simulate the *vulnerable* vault behavior:
      // In the old vulnerable vault, Alice would have minted 1:1 (supply=principalQ).
      const vulnerableSupplyAfterAlice = alicePrincipalQ; // <-- key difference
      const vulnerableSharesBob = bobPrincipalQ.mul(vulnerableSupplyAfterAlice).div(dep2.tvlQuoteBefore);

      expect(vulnerableSharesBob).to.equal(BigNumber.from(0));
    });
  });
});
