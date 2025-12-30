import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import * as dotenv from 'dotenv';

dotenv.config();

const DEFAULT_COMPILER_SETTINGS = {
  version: '0.8.24',
  settings: {
    optimizer: {
      enabled: true,
      runs: 1000,
    },
    viaIR: true
    // metadata: {
    //   bytecodeHash: 'none',
    // },
  },
}

const config: HardhatUserConfig = {
  solidity: {
    compilers: [DEFAULT_COMPILER_SETTINGS]
  },
  networks: {
    hardhat: {
      // in-memory network used by `npx hardhat test`
    },
    localhost: {
      url: "http://127.0.0.1:8545",
      // chainId: 31337, // optional, but typical
    },
    hederaTestnet: {
      url: "https://testnet.hashio.io/api",
      chainId: 296,
      accounts: [process.env.TESTNET_MYPRIVATEKEY!], // 0x...
    },
  },
};

export default config;