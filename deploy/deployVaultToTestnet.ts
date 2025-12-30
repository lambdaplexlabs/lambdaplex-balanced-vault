import * as dotenv from 'dotenv';
// import { TokenId } from '@hashgraph/sdk';
import { ethers } from 'hardhat';

dotenv.config({ path: '../env'})

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deployer:", deployer.address);

  const vaultFactory = await ethers.getContractFactory("PLEXPairVaultHedera", deployer);

  const vault = await vaultFactory.deploy(
    "0x000000000000000000000000000000000069b5f1",
    "0x000000000000000000000000000000000059210c",
    "0x000000000000000000000000000000000069b5f1",
    "0x000000000000000000000000000000000059210c",
    "0x000000000000000000000000000000000069b5f2",
    1000,
  );

  console.log("Vault deployed to:", vault.address);
}

main()