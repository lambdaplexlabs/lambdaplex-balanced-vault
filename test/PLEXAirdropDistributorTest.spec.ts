import { expect } from "chai";
import { ethers, network } from "hardhat";
import { BigNumber, Contract, Signer } from "ethers";
import { AirdropDistributor, ERC20Mock, PLEXPairVault } from "../typechain-types";

describe("AirdropDistributor", () => {
  let deployer: Signer;
  let alice: Signer;
  let bob: Signer;

  let token0: ERC20Mock;
  let token1: ERC20Mock;
  let reward: ERC20Mock;

  let distributor: AirdropDistributor;
  let vault: PLEXPairVault;

  const INITIAL_MINT = 1_000_000_000;
  const DECIMALS = 8;
  const ONE = BigNumber.from(10).pow(DECIMALS);

  // vault constructor param
  const initOwnerBips = 0;

  async function mintApprove(
    who: Signer,
    token: ERC20Mock,
    spender: string,
    amount: BigNumber
  ) {
    const whoAddr = await who.getAddress();
    await token.transfer(whoAddr, amount);
    await token.connect(who).approve(spender, amount);
  }

  beforeEach(async () => {
    [deployer, alice, bob] = await ethers.getSigners();

    // ---------- Deploy mock tokens ----------
    const ERC20MockFactory = await ethers.getContractFactory("ERC20Mock");
    token0 = (await ERC20MockFactory.deploy("Token0", "TK0", DECIMALS, INITIAL_MINT)) as ERC20Mock;
    await token0.deployed();

    token1 = (await ERC20MockFactory.deploy("Token1", "TK1", DECIMALS, INITIAL_MINT)) as ERC20Mock;
    await token1.deployed();

    reward = (await ERC20MockFactory.deploy("Reward", "RWD", DECIMALS, INITIAL_MINT)) as ERC20Mock;
    await reward.deployed();

    // ---------- Deploy distributor ----------
    const DistributorFactory = await ethers.getContractFactory("AirdropDistributor");
    distributor = (await DistributorFactory.deploy()) as AirdropDistributor;
    await distributor.deployed();

    // ---------- Deploy vault ----------
    // NOTE: We do not need to mock Supra here because these tests only use onAirdropFunded,
    // which doesn't touch the oracle (no deposits/withdrawals).
    const VaultFactory = await ethers.getContractFactory("PLEXPairVault");
    vault = (await VaultFactory.deploy(
      token0.address,
      token1.address,
      token0.address,
      token1.address,
      distributor.address,
      initOwnerBips
    )) as PLEXPairVault;
    await vault.deployed();
  });

  describe("token allowlist", () => {
    it("reverts fund() when token is NOT allowlisted (so it cannot be added/listed in the vault)", async () => {
      const aliceAddr = await alice.getAddress();
      const amount = ONE.mul(1_000);

      // Alice gets reward tokens + approves distributor
      await reward.transfer(aliceAddr, amount);
      await reward.connect(alice).approve(distributor.address, amount);

      // default should be false
      expect(await distributor.isTokenAllowed(reward.address)).to.equal(false);

      // fund should revert with custom error
      await expect(
        distributor.connect(alice).fund(vault.address, reward.address, amount)
      ).to.be.revertedWithCustomError(distributor, "NotAllowedToken");

      // no transfer happened
      expect(await reward.balanceOf(distributor.address)).to.equal(0);

      // no credit happened
      expect(await distributor.credited(vault.address, reward.address)).to.equal(0);
      expect(await distributor.claimed(vault.address, reward.address)).to.equal(0);

      // vault should NOT have initialized reward state for this token
      const rd = await vault.rewards(reward.address);
      expect(rd.perShare).to.equal(0);
      expect(rd.rate).to.equal(0);
      expect(rd.lastUpdate).to.equal(0);
      expect(rd.periodFinish).to.equal(0);

      // and it should NOT be present in vault.rewardTokens
      await expect(vault.rewardTokens(0)).to.be.revertedWithoutReason(); // out-of-bounds
    });

    it("only owner can allowlist tokens; allowlisted token can fund and becomes listed in vault rewardTokens", async () => {
      const aliceAddr = await alice.getAddress();
      const amount = ONE.mul(1_000);

      // Non-owner cannot allowlist
      await expect(
        distributor.connect(alice).modifyAllowed(reward.address, true)
      ).to.be.revertedWith("Ownable: caller is not the owner");

      // Owner allowlists
      await distributor.modifyAllowed(reward.address, true);
      expect(await distributor.isTokenAllowed(reward.address)).to.equal(true);

      // Alice funds the vault with reward token
      await reward.transfer(aliceAddr, amount);
      await reward.connect(alice).approve(distributor.address, amount);

      const vesting = await distributor.VESTING_SECS();

      const tx = await distributor.connect(alice).fund(vault.address, reward.address, amount);
      const rcpt = await tx.wait();
      const block = await ethers.provider.getBlock(rcpt.blockNumber);
      if (!block) throw new Error("block not found");

      await expect(tx)
        .to.emit(distributor, "Funded")
        .withArgs(vault.address, reward.address, amount, vesting);

      // Distributor received tokens and credited the vault
      expect(await reward.balanceOf(distributor.address)).to.equal(amount);
      expect(await distributor.credited(vault.address, reward.address)).to.equal(amount);
      expect(await distributor.remaining(vault.address, reward.address)).to.equal(amount);

      // Vault was notified and started a reward stream
      const rd = await vault.rewards(reward.address);
      expect(rd.lastUpdate).to.equal(BigNumber.from(block.timestamp));
      expect(rd.periodFinish).to.equal(BigNumber.from(block.timestamp).add(vesting));
      expect(rd.rate).to.be.gt(0);

      // Vault should list token exactly once
      expect(await vault.rewardTokens(0)).to.equal(reward.address);
      await expect(vault.rewardTokens(1)).to.be.revertedWithoutReason();
    });

    it("does not duplicate a reward token in the vault when funding the same token multiple times", async () => {
      const aliceAddr = await alice.getAddress();
      const amount = ONE.mul(1_000);

      await distributor.modifyAllowed(reward.address, true);

      // Alice has enough for two fundings
      await reward.transfer(aliceAddr, amount.mul(2));
      await reward.connect(alice).approve(distributor.address, amount.mul(2));

      await distributor.connect(alice).fund(vault.address, reward.address, amount);
      await distributor.connect(alice).fund(vault.address, reward.address, amount);

      // Still only one entry in vault.rewardTokens
      expect(await vault.rewardTokens(0)).to.equal(reward.address);
      await expect(vault.rewardTokens(1)).to.be.revertedWithoutReason();

      // Credits accumulated
      expect(await distributor.credited(vault.address, reward.address)).to.equal(amount.mul(2));
    });
  });
  // ─────────────────────────────────────────────────────────────
  // fund()
  // ─────────────────────────────────────────────────────────────
  describe("fund()", () => {

    let goodVault: Contract;       // MockNotifyVault
    let revertingVault: Contract;  // RevertingNotifyVault
    let reenterVault: Contract;    // ReenteringNotifyVault

    beforeEach(async() => {

      // Mock vaults
      const GoodVaultFactory = await ethers.getContractFactory("MockNotifyVault");
      goodVault = await GoodVaultFactory.deploy();
      await goodVault.deployed();

      const RevertingFactory = await ethers.getContractFactory("RevertingNotifyVault");
      revertingVault = await RevertingFactory.deploy();
      await revertingVault.deployed();

      const ReenterFactory = await ethers.getContractFactory("ReenteringNotifyVault");
      reenterVault = await ReenterFactory.deploy();
      await reenterVault.deployed();
    })

    it("reverts on bad args: zero vault or zero token", async () => {
      const amt = ONE.mul(100);

      await expect(
        distributor.fund(ethers.constants.AddressZero, reward.address, amt)
      ).to.be.revertedWith("bad args");

      await expect(
        distributor.fund(goodVault.address, ethers.constants.AddressZero, amt)
      ).to.be.revertedWith("bad args");
    });

    it("reverts on amt=0", async () => {
      await expect(
        distributor.fund(goodVault.address, reward.address, 0)
      ).to.be.revertedWith("amt=0");
    });

    it("reverts with NotAllowedToken if token is not allowlisted; vault callback is not executed", async () => {
      const amt = ONE.mul(1000);

      await mintApprove(alice, reward, distributor.address, amt);

      // sanity
      expect(await distributor.isTokenAllowed(reward.address)).to.equal(false);

      await expect(
        distributor.connect(alice).fund(goodVault.address, reward.address, amt)
      ).to.be.revertedWithCustomError(distributor, "NotAllowedToken");

      // Nothing moved / credited
      expect(await reward.balanceOf(distributor.address)).to.equal(0);
      expect(await distributor.credited(goodVault.address, reward.address)).to.equal(0);
      expect(await distributor.claimed(goodVault.address, reward.address)).to.equal(0);

      // Callback not executed
      expect(await goodVault.calls()).to.equal(0);
      expect(await goodVault.lastToken()).to.equal(ethers.constants.AddressZero);
      expect(await goodVault.lastAmount()).to.equal(0);
    });

    it("returns netAmount == amount (callStatic)", async () => {
      const amt = ONE.mul(1234);

      await distributor.modifyAllowed(reward.address, true);
      await mintApprove(alice, reward, distributor.address, amt);

      const net = await distributor.connect(alice).callStatic.fund(
        goodVault.address,
        reward.address,
        amt
      );

      expect(net).to.equal(amt);
    });

    it("successful fund: transfers tokens in, credits the vault, emits event, and calls the vault callback with correct args", async () => {
      const amt = ONE.mul(1000);
      await distributor.modifyAllowed(reward.address, true);

      await mintApprove(alice, reward, distributor.address, amt);

      const vesting = await distributor.VESTING_SECS();

      const tx = await distributor.connect(alice).fund(goodVault.address, reward.address, amt);

      await expect(tx)
        .to.emit(distributor, "Funded")
        .withArgs(goodVault.address, reward.address, amt, vesting);

      // custody + accounting
      expect(await reward.balanceOf(distributor.address)).to.equal(amt);
      expect(await distributor.credited(goodVault.address, reward.address)).to.equal(amt);
      expect(await distributor.claimed(goodVault.address, reward.address)).to.equal(0);
      expect(await distributor.remaining(goodVault.address, reward.address)).to.equal(amt);

      // callback happened
      expect(await goodVault.calls()).to.equal(1);
      expect(await goodVault.lastToken()).to.equal(reward.address);
      expect(await goodVault.lastAmount()).to.equal(amt);
    });

    it("accumulates credits across multiple fund() calls and does not touch claimed", async () => {
      const amt = ONE.mul(500);
      await distributor.modifyAllowed(reward.address, true);

      await mintApprove(alice, reward, distributor.address, amt.mul(2));

      await distributor.connect(alice).fund(goodVault.address, reward.address, amt);
      await distributor.connect(alice).fund(goodVault.address, reward.address, amt);

      expect(await reward.balanceOf(distributor.address)).to.equal(amt.mul(2));
      expect(await distributor.credited(goodVault.address, reward.address)).to.equal(amt.mul(2));
      expect(await distributor.claimed(goodVault.address, reward.address)).to.equal(0);
      expect(await distributor.remaining(goodVault.address, reward.address)).to.equal(amt.mul(2));

      // callback executed twice
      expect(await goodVault.calls()).to.equal(2);
      expect(await goodVault.lastAmount()).to.equal(amt);
    });

    it("tracks credits per vault independently (vault A != vault B)", async () => {
      await distributor.modifyAllowed(reward.address, true);

      const VaultFactory = await ethers.getContractFactory("MockNotifyVault");
      const vaultA = await VaultFactory.deploy();
      const vaultB = await VaultFactory.deploy();
      await vaultA.deployed();
      await vaultB.deployed();

      const aAmt = ONE.mul(111);
      const bAmt = ONE.mul(222);

      await mintApprove(alice, reward, distributor.address, aAmt.add(bAmt));

      await distributor.connect(alice).fund(vaultA.address, reward.address, aAmt);
      await distributor.connect(alice).fund(vaultB.address, reward.address, bAmt);

      expect(await distributor.credited(vaultA.address, reward.address)).to.equal(aAmt);
      expect(await distributor.credited(vaultB.address, reward.address)).to.equal(bAmt);

      expect(await distributor.remaining(vaultA.address, reward.address)).to.equal(aAmt);
      expect(await distributor.remaining(vaultB.address, reward.address)).to.equal(bAmt);

      // total custody equals sum of credits (since no claims)
      expect(await reward.balanceOf(distributor.address)).to.equal(aAmt.add(bAmt));
    });

    it("is atomic if vault callback reverts: no tokens/credits remain", async () => {
      const amt = ONE.mul(1000);
      await distributor.modifyAllowed(reward.address, true);

      const aliceAddr = await alice.getAddress();
      await mintApprove(alice, reward, distributor.address, amt);

      const aliceBefore = await reward.balanceOf(aliceAddr);
      const distBefore = await reward.balanceOf(distributor.address);

      await expect(
        distributor.connect(alice).fund(revertingVault.address, reward.address, amt)
      ).to.be.revertedWith("VAULT_REVERT");

      // everything rolled back
      expect(await reward.balanceOf(aliceAddr)).to.equal(aliceBefore);
      expect(await reward.balanceOf(distributor.address)).to.equal(distBefore);

      expect(await distributor.credited(revertingVault.address, reward.address)).to.equal(0);
      expect(await distributor.claimed(revertingVault.address, reward.address)).to.equal(0);
    });

    it("reverts on reentrancy if vault attempts to re-enter fund() during callback; state remains unchanged", async () => {
      const amt = ONE.mul(1000);
      await distributor.modifyAllowed(reward.address, true);

      const aliceAddr = await alice.getAddress();
      await mintApprove(alice, reward, distributor.address, amt);

      // arm vault to attempt re-entry (inner call will revert with 'reentrancy')
      await reenterVault.arm(distributor.address, reward.address, ONE);

      const aliceBefore = await reward.balanceOf(aliceAddr);

      await expect(
        distributor.connect(alice).fund(reenterVault.address, reward.address, amt)
      ).to.be.revertedWith("reentrancy");

      // rolled back
      expect(await reward.balanceOf(aliceAddr)).to.equal(aliceBefore);
      expect(await reward.balanceOf(distributor.address)).to.equal(0);

      expect(await distributor.credited(reenterVault.address, reward.address)).to.equal(0);
      expect(await distributor.claimed(reenterVault.address, reward.address)).to.equal(0);
    });

    it("reverts if allowance is missing (standard ERC20)", async () => {
      const amt = ONE.mul(10);
      await distributor.modifyAllowed(reward.address, true);

      const aliceAddr = await alice.getAddress();
      await reward.transfer(aliceAddr, amt);

      // do NOT approve distributor

      await expect(
        distributor.connect(alice).fund(goodVault.address, reward.address, amt)
      ).to.be.revertedWith("ERC20: insufficient allowance");

      // no credit
      expect(await distributor.credited(goodVault.address, reward.address)).to.equal(0);
      expect(await reward.balanceOf(distributor.address)).to.equal(0);
    });
  });
  // ─────────────────────────────────────────────────────────────
  // claimTo()
  // ─────────────────────────────────────────────────────────────
  describe("claimTo()", () => {

    let vaultA: Contract; // MockVaultWithClaim
    let vaultB: Contract; // MockVaultWithClaim

    beforeEach(async () => {
      [deployer, alice, bob] = await ethers.getSigners();

      const VaultFactory = await ethers.getContractFactory("MockVaultWithClaim");
      vaultA = await VaultFactory.deploy(distributor.address);
      await vaultA.deployed();

      vaultB = await VaultFactory.deploy(distributor.address);
      await vaultB.deployed();
    });

    it("reverts if caller is not the credited vault (InsufficientBalance)", async () => {
      const fundAmt = ONE.mul(1000);

      await distributor.modifyAllowed(reward.address, true);
      await mintApprove(alice, reward, distributor.address, fundAmt);

      // credit vaultA
      await distributor.connect(alice).fund(vaultA.address, reward.address, fundAmt);

      const bobAddr = await bob.getAddress();

      // EOA tries to claim from vaultA credit => should revert OnlyVault
      await expect(
        distributor.connect(alice).claimTo(reward.address, bobAddr, ONE)
      ).to.be.revertedWithCustomError(distributor, "InsufficientBalance");
    });

    it("reverts on bad args: to=0 or amount=0 (called via vault)", async () => {
      const fundAmt = ONE.mul(1000);
      await distributor.modifyAllowed(reward.address, true);
      await mintApprove(alice, reward, distributor.address, fundAmt);
      await distributor.connect(alice).fund(vaultA.address, reward.address, fundAmt);

      // to=0
      await expect(
        vaultA.claim(reward.address, ethers.constants.AddressZero, ONE)
      ).to.be.revertedWith("bad args");

      // amount=0
      const bobAddr = await bob.getAddress();
      await expect(
        vaultA.claim(reward.address, bobAddr, 0)
      ).to.be.revertedWith("bad args");
    });

    it("reverts if amount > remaining credit (InsufficientBalance)", async () => {
      const fundAmt = ONE.mul(100);
      await distributor.modifyAllowed(reward.address, true);
      await mintApprove(alice, reward, distributor.address, fundAmt);
      await distributor.connect(alice).fund(vaultA.address, reward.address, fundAmt);

      const bobAddr = await bob.getAddress();

      // try to claim more than credited
      await expect(
        vaultA.claim(reward.address, bobAddr, fundAmt.add(1))
      ).to.be.revertedWithCustomError(distributor, "InsufficientBalance");

      // ensure accounting unchanged
      expect(await distributor.claimed(vaultA.address, reward.address)).to.equal(0);
      expect(await distributor.remaining(vaultA.address, reward.address)).to.equal(fundAmt);
      expect(await reward.balanceOf(bobAddr)).to.equal(0);
    });

    it("successful claim transfers tokens, increments claimed, and emits Claimed", async () => {
      const fundAmt = ONE.mul(1000);
      const claimAmt = ONE.mul(123);

      await distributor.modifyAllowed(reward.address, true);
      await mintApprove(alice, reward, distributor.address, fundAmt);
      await distributor.connect(alice).fund(vaultA.address, reward.address, fundAmt);

      const bobAddr = await bob.getAddress();
      const bobBefore = await reward.balanceOf(bobAddr);

      const tx = await vaultA.claim(reward.address, bobAddr, claimAmt);

      await expect(tx)
        .to.emit(distributor, "Claimed")
        .withArgs(vaultA.address, bobAddr, reward.address, claimAmt);

      const bobAfter = await reward.balanceOf(bobAddr);
      expect(bobAfter.sub(bobBefore)).to.equal(claimAmt);

      // credited is unchanged; claimed increases
      expect(await distributor.credited(vaultA.address, reward.address)).to.equal(fundAmt);
      expect(await distributor.claimed(vaultA.address, reward.address)).to.equal(claimAmt);
      expect(await distributor.remaining(vaultA.address, reward.address)).to.equal(fundAmt.sub(claimAmt));
    });

    it("supports multiple claims until depleted; then further claims revert", async () => {
      const fundAmt = ONE.mul(500);

      await distributor.modifyAllowed(reward.address, true);
      await mintApprove(alice, reward, distributor.address, fundAmt);
      await distributor.connect(alice).fund(vaultA.address, reward.address, fundAmt);

      const bobAddr = await bob.getAddress();

      // claim in two chunks
      const a = ONE.mul(200);
      const b = fundAmt.sub(a);

      await vaultA.claim(reward.address, bobAddr, a);
      await vaultA.claim(reward.address, bobAddr, b);

      expect(await distributor.remaining(vaultA.address, reward.address)).to.equal(0);
      expect(await distributor.claimed(vaultA.address, reward.address)).to.equal(fundAmt);

      // now any further claim must revert
      await expect(
        vaultA.claim(reward.address, bobAddr, ONE)
      ).to.be.revertedWithCustomError(distributor, "InsufficientBalance");
    });

    it("credits/claims are tracked per-vault independently", async () => {
      const amtA = ONE.mul(1000);
      const amtB = ONE.mul(500);

      await distributor.modifyAllowed(reward.address, true);
      await mintApprove(alice, reward, distributor.address, amtA.add(amtB));

      await distributor.connect(alice).fund(vaultA.address, reward.address, amtA);
      await distributor.connect(alice).fund(vaultB.address, reward.address, amtB);

      const bobAddr = await bob.getAddress();

      await vaultA.claim(reward.address, bobAddr, ONE.mul(100));
      await vaultB.claim(reward.address, bobAddr, ONE.mul(200));

      expect(await distributor.remaining(vaultA.address, reward.address)).to.equal(amtA.sub(ONE.mul(100)));
      expect(await distributor.remaining(vaultB.address, reward.address)).to.equal(amtB.sub(ONE.mul(200)));
    });

    it("disallowing a token blocks future fund(), but does NOT block paying out existing credited balances via claimTo()", async () => {
      const fundAmt = ONE.mul(1000);
      const claimAmt = ONE.mul(10);

      await distributor.modifyAllowed(reward.address, true);
      await mintApprove(alice, reward, distributor.address, fundAmt);
      await distributor.connect(alice).fund(vaultA.address, reward.address, fundAmt);

      // disallow it now
      await distributor.modifyAllowed(reward.address, false);

      const bobAddr = await bob.getAddress();

      // claim still works
      await vaultA.claim(reward.address, bobAddr, claimAmt);

      expect(await distributor.claimed(vaultA.address, reward.address)).to.equal(claimAmt);
      expect(await distributor.remaining(vaultA.address, reward.address)).to.equal(fundAmt.sub(claimAmt));

      // but future fund should now revert
      await mintApprove(alice, reward, distributor.address, ONE.mul(1));
      await expect(
        distributor.connect(alice).fund(vaultA.address, reward.address, ONE.mul(1))
      ).to.be.revertedWithCustomError(distributor, "NotAllowedToken");
    });
    // ─────────────────────────────────────────────────────────────
    // Invariants: claimed never exceeds credited (mini fuzz)
    // ─────────────────────────────────────────────────────────────
    describe("invariants: claimed never exceeds credited", () => {
      it("mini fuzz: random fund/claim operations preserve claimed<=credited and remaining math", async () => {
        // Allow token for funding
        await distributor.modifyAllowed(reward.address, true);

        const aliceAddr = await alice.getAddress();
        const bobAddr = await bob.getAddress();

        // Give Alice plenty of reward tokens to fund with
        const bankroll = ONE.mul(1_000_000); // 1,000,000 tokens (8 decimals => 1e14 units)
        await reward.transfer(aliceAddr, bankroll);
        await reward.connect(alice).approve(distributor.address, bankroll);

        // Deterministic PRNG (LCG) so the test is reproducible
        let seed = 123456789;
        const rand = () => {
          seed = (seed * 1103515245 + 12345) & 0x7fffffff;
          return seed;
        };

        const vaults = [vaultA, vaultB];
        const vAddrs = [vaultA.address, vaultB.address];

        // Local mirrors of expected state
        let creditedLocal = [BigNumber.from(0), BigNumber.from(0)];
        let claimedLocal = [BigNumber.from(0), BigNumber.from(0)];

        const STEPS = 150;
        const MAX_FUND_TOKENS = 500;  // max 500 tokens per fund
        const MAX_CLAIM_TOKENS = 300; // max 300 tokens per claim

        for (let step = 0; step < STEPS; step++) {
          const v = rand() % vaults.length;
          const actionRoll = rand() % 100;

          const remainingLocal = creditedLocal[v].sub(claimedLocal[v]);

          if (actionRoll < 55) {
            // ----------------------------
            // FUND
            // ----------------------------
            const tokens = (rand() % MAX_FUND_TOKENS) + 1; // 1..MAX_FUND_TOKENS
            const amount = ONE.mul(tokens);

            await distributor.connect(alice).fund(vAddrs[v], reward.address, amount);
            creditedLocal[v] = creditedLocal[v].add(amount);

          } else {
            // ----------------------------
            // CLAIM
            // ----------------------------
            if (remainingLocal.isZero()) {
              // Try an over-claim when rem=0; must revert and change nothing
              await expect(
                vaults[v].claim(reward.address, bobAddr, ONE) // 1 token
              ).to.be.revertedWithCustomError(distributor, "InsufficientBalance");

            } else {
              const overClaimRoll = rand() % 100;

              if (overClaimRoll < 20) {
                // 20% chance: try to over-claim (must revert)
                const extraTokens = (rand() % MAX_CLAIM_TOKENS) + 1;
                const attempt = remainingLocal.add(ONE.mul(extraTokens));

                await expect(
                  vaults[v].claim(reward.address, bobAddr, attempt)
                ).to.be.revertedWithCustomError(distributor, "InsufficientBalance");

              } else {
                // 80% chance: valid claim <= remaining
                // Keep sizes small so toNumber() stays safe
                const remTokens = remainingLocal.div(ONE).toNumber(); // safe because our totals are small
                const tokens = Math.min(remTokens, (rand() % MAX_CLAIM_TOKENS) + 1);
                const amount = ONE.mul(tokens);

                await vaults[v].claim(reward.address, bobAddr, amount);
                claimedLocal[v] = claimedLocal[v].add(amount);
              }
            }
          }

          // ----------------------------
          // Invariant checks after every step
          // ----------------------------
          for (let j = 0; j < vaults.length; j++) {
            const onCredited = await distributor.credited(vAddrs[j], reward.address);
            const onClaimed  = await distributor.claimed(vAddrs[j], reward.address);

            // Exact state matches our local mirror for successful ops
            expect(onCredited).to.equal(creditedLocal[j]);
            expect(onClaimed).to.equal(claimedLocal[j]);

            // Critical invariant: claimed never exceeds credited
            expect(onClaimed.lte(onCredited)).to.equal(true);

            // remaining must equal credited - claimed
            const onRemaining = await distributor.remaining(vAddrs[j], reward.address);
            expect(onRemaining).to.equal(onCredited.sub(onClaimed));
          }

          // Distributor should hold exactly the sum of remaining across vaults for this token
          const sumRemaining =
            creditedLocal[0].sub(claimedLocal[0]).add(creditedLocal[1].sub(claimedLocal[1]));

          const distBal = await reward.balanceOf(distributor.address);
          expect(distBal).to.equal(sumRemaining);
        }
      });
    });
  });
});