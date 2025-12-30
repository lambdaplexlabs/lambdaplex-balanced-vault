import { AccountId, AccountUpdateTransaction, Client, ContractCreateTransaction, ContractId, ContractLogInfo, ContractUpdateTransaction, TransactionId, TransactionRecordQuery } from '@hashgraph/sdk'
import { Contract, ethers as ethersUtils } from 'ethers'
import {
  BigNumber, BigNumberish
} from 'ethers'
import bn from 'bignumber.js'
import { BytesLike, defaultAbiCoder, getAddress, isAddress, keccak256, solidityPack, toUtf8Bytes } from 'ethers/lib/utils'
import Web3 from 'web3'
import { JsonObject, TokenTransfers, Transfer } from './types'
import { FeeAmount } from './constants'

const ADDR_SIZE = 20
const FEE_SIZE = 3
const OFFSET = ADDR_SIZE + FEE_SIZE
const DATA_SIZE = OFFSET + ADDR_SIZE

export function decodePrefixBytes32(encodedHex: string) {
  if (!/^0x[a-fA-F0-9]{64}$/.test(encodedHex)) {
    throw new Error("Expected 32-byte hex string");
  }
  const raw = BigInt(encodedHex);

  const orderType = Number((raw >> 248n) & 0xffn);
  const flags     = Number((raw >> 240n) & 0xffn);
  const outToken  = (raw >> 176n) & ((1n << 64n) - 1n);
  const inToken   = (raw >> 112n) & ((1n << 64n) - 1n);
  const expiration= Number((raw >> 80n) & ((1n << 32n) - 1n));
  const feeBips   = Number((raw >> 56n) & ((1n << 24n) - 1n));
  const salt      = raw & ((1n << 56n) - 1n);

  return {
    orderType,  // 0..255
    flags,      // 0..255
    outToken: "0x" + outToken.toString(16).padStart(16, "0"), // 64-bit
    inToken:  "0x" + inToken.toString(16).padStart(16, "0"),
    expiration,
    feeBips,
    salt: "0x" + salt.toString(16).padStart(14, "0") // 56 bits
  };
}

export function decodeDetailSlot0(encoded: string) {
  if (!/^0x[a-fA-F0-9]{64}$/.test(encoded)) {
    throw new Error("Invalid encoded input: must be a 32-byte (64 hex characters) string.");
  }

  const raw = BigInt(encoded);

  const quantity    = (raw >> 193n) & ((1n << 63n) - 1n);
  const numerator   = (raw >> 130n) & ((1n << 63n) - 1n);
  const denominator = (raw >>  67n) & ((1n << 63n) - 1n);
  const slippage    = (raw >>   4n) & ((1n << 63n) - 1n);

  return {
    quantity,
    numerator,
    denominator,
    slippage
  };
}

/**
 * Encode prefix fields into a 32-byte word.
 *
 * Layout (MSB→LSB):
 *   [252..255] : orderType (uint8)
 *   [244..251] : flags     (uint8)
 *   [176..243] : outToken  (uint64, low 8 bytes of address)
 *   [112..175] : inToken   (uint64, low 8 bytes of address)
 *   [ 80..111] : expiration (uint32)
 *   [ 56.. 79] : feeBips   (uint24)
 *   [  0.. 55] : salt      (uint56)
 */
export function encodePrefixParams32(
  orderType: number,   // 0..255
  flags: number,       // 0..255 (bitmask)
  outToken: string,    // 0x-prefixed address
  inToken: string,     // 0x-prefixed address
  expiration: number,  // uint32
  feeBips24: bigint,   // 0..1e6
  salt56: bigint       // 56-bit value
): string {
  if (orderType < 0 || orderType > 0xff) throw new Error("orderType must fit in 1 byte");
  if (flags < 0 || flags > 0xff) throw new Error("flags must fit in 1 byte");
  // if (feeBips24 >= 1_000_000n) throw new Error("feeBips must be < 1e6");

  // Convert addresses → BigInt (keep only low 64 bits)
  const outTokenNum = BigInt(outToken) & ((1n << 64n) - 1n);
  const inTokenNum  = BigInt(inToken)  & ((1n << 64n) - 1n);

  const ot   = (BigInt(orderType) & 0xffn) << 248n;
  const flg  = (BigInt(flags)     & 0xffn) << 240n;
  const out  = (outTokenNum & ((1n<<64n)-1n)) << 176n;
  const inn  = (inTokenNum  & ((1n<<64n)-1n)) << 112n;
  const exp  = (BigInt(expiration) & ((1n<<32n)-1n)) << 80n;
  const fee  = (feeBips24          & ((1n<<24n)-1n)) << 56n;
  const slt  = (salt56             & ((1n<<56n)-1n));

  const val = ot | flg | out | inn | exp | fee | slt;
  return "0x" + val.toString(16).padStart(64, "0");
}

export function encodeDetailSlot0(
  quantity: bigint,
  numerator: bigint,
  denominator: bigint,
  slippage: bigint
): string {
  // Bounds check: each must fit in 63 bits
  if (quantity >= 2n**63n || numerator >= 2n**63n || denominator >= 2n**63n || slippage >= 2n**63n) {
    throw new Error("all fields must be less than 2^63");
  }
  if (quantity <= 0n || numerator <= 0n || denominator <= 0n) {
    throw new Error("all fields must be > 0");
  }

  // Pack into 256-bit word
  const encoded =
      (quantity   << 193n) | // 63 bits
      (numerator  << 130n) | // 63 bits
      (denominator<<  67n) | // 63 bits
      (slippage   <<   4n);  // 63 bits (lowest 4 bits unused)

  // Convert to hex string and pad to 32 bytes
  return "0x" + encoded.toString(16).padStart(64, "0");
}

export function computeOrderStorageSlot(mappingSlot: number, key: string): string {
  // Ensure mappingSlot is a valid uint256
  if (mappingSlot < 0 || mappingSlot > 2n ** 256n - 1n) {
    throw new Error("Invalid mappingSlot: must be a uint256 value.");
  }

  // Compute the storage slot using keccak256(abi.encode(key, mappingSlot))
  const slot = ethersUtils.utils.keccak256(
    ethersUtils.utils.defaultAbiCoder.encode(["bytes32", "uint256"], [key, mappingSlot])
  );

  return slot;
}

export function getProposedTransfersJSON(hbarTransferInfo: Transfer[], tokenTransferList: TokenTransfers[]) {
  let jsonObject: JsonObject = {
    direct: {
        hbar: {
            transfers: []
        },
        tokens: []
    },
    customFee: {
        hbar: {
            transfers: []
        },
        tokens: []
    }
  };

  for (var i = 0; i < hbarTransferInfo.length; i++) {
    jsonObject.direct.hbar.transfers.push({
      accountID: hbarTransferInfo[i].accountID,
      amount: hbarTransferInfo[i].amount,
      isApproval: hbarTransferInfo[i].isApproval
    });
  }

  for (var i = 0; i < tokenTransferList.length; i++) {
    let tempTransfer: Transfer[] = [];
    for (var j = 0; j < tokenTransferList[i].transfers.length; j++) {
      tempTransfer.push({
        accountID: tokenTransferList[i].transfers[j].accountID,
        amount: tokenTransferList[i].transfers[j].amount,
        isApproval: tokenTransferList[i].transfers[j].isApproval
      });
    }
    jsonObject.direct.tokens.push({
      token: tokenTransferList[i].token,
      transfers: tempTransfer,
      nftTransfers: []
    })
  }

  return jsonObject;
}

bn.config({ EXPONENTIAL_AT: 999999, DECIMAL_PLACES: 40 })

// returns the sqrt price as a 64x96
export function encodePriceSqrt(reserve1: BigNumberish, reserve0: BigNumberish): BigNumber {
  return BigNumber.from(
    new bn(reserve1.toString())
      .div(reserve0.toString())
      .sqrt()
      .multipliedBy(new bn(2).pow(96))
      .integerValue(3)
      .toString()
  )
}

// 0.05% - 10, 0.3% - 60, 1% - 200
export const getMinTick = (tickSpacing: number) => Math.ceil(-887272 / tickSpacing) * tickSpacing
export const getMaxTick = (tickSpacing: number) => Math.floor(887272 / tickSpacing) * tickSpacing

/**
 * Concatenate a 32-byte key, an int64 amount, and a uint24 fee.
 *
 * Result layout (big-endian, Solidity-style):
 *   [bytes32 key][int64 amountToSwap][uint24 fee]  // total 43 bytes
 */
export function encodeKeyAmountFeePacked(
  key: BytesLike,
  amountToSwap: BigNumberish,
  fee: number
): string {
  // --- validation ----------------------------------------------------------
  const keyBytes = ethersUtils.utils.arrayify(key);
  if (keyBytes.length !== 32) {
    throw new Error("key must be exactly 32 bytes");
  }

  // int64 range check: –2^63 … 2^63-1
  const amtBN = BigNumber.from(amountToSwap);
  const MIN_I64 = BigNumber.from("-9223372036854775808"); // -9 223 372 036 854 775 808
  const MAX_I64 = BigNumber.from( "9223372036854775807"); //  9 223 372 036 854 775 807
  if (amtBN.lt(MIN_I64) || amtBN.gt(MAX_I64)) {
    throw new Error("amountToSwap is outside int64 range");
  }

  // uint24 range check: 0 … 16 777 215
  if (!Number.isInteger(fee) || fee < 0 || fee > 0xffffff) {
    throw new Error("fee must be a uint24 (0 – 16 777 215)");
  }

  // --- packing -------------------------------------------------------------
  return ethersUtils.utils.solidityPack(
    ["bytes32", "int64", "uint24"],
    [keyBytes, amtBN, fee]
  );
}

/**
 * ABI-encode a 32-byte key, an int64 amount, and a uint24 fee.
 *
 * Result layout (canonical ABI, 32-byte slots):
 *   0–31   : bytes32  key
 *   32–63  : int64    amountToSwap (right-aligned, two’s complement)
 *   64–95  : uint24   fee          (right-aligned)
 *
 * Total: 96 bytes  →  "0x" + 192 hex digits.
 */
export function encodeKeyAmountFee(
  key: BytesLike,
  amountToSwap: BigNumberish,
  fee: number,
  feeCollector?: string
): string {
  /* ---------- validation ------------------------------------------------- */
  const keyBytes = ethersUtils.utils.arrayify(key);
  if (keyBytes.length !== 32) {
    throw new Error("key must be exactly 32 bytes");
  }

  // int64 bounds  (-2^63 … 2^63-1)
  const amtBN = BigNumber.from(amountToSwap);
  const MIN_I64 = BigNumber.from("-9223372036854775808"); // -2^63
  const MAX_I64 = BigNumber.from("9223372036854775807");  //  2^63-1
  if (amtBN.lt(MIN_I64) || amtBN.gt(MAX_I64)) {
    throw new Error("amountToSwap is outside int64 range");
  }

  // uint24 bounds  (0 … 16 777 215)
  if (!Number.isInteger(fee) || fee < 0 || fee > 0xffffff) {
    throw new Error("fee must be a uint24 (0 – 16 777 215)");
  }

  /* ---------- ABI-encoding ----------------------------------------------- */
  if (feeCollector) {
    // include the optional address
    return ethersUtils.utils.defaultAbiCoder.encode(
      ["bytes32", "int64", "uint24", "address"],
      [keyBytes, amtBN, fee, feeCollector]
    );
  } else {
    // omit feeCollector; on-chain code should default to msg.sender
    return ethersUtils.utils.defaultAbiCoder.encode(
      ["bytes32", "int64", "uint24"],
      [keyBytes, amtBN, fee]
    );
  }
}

/**
 * Multiply `a` and `b`, then divide by `c`, rounding down.
 *
 * All math is done with bigint so the result is exact and overflow-safe
 * (up to 2²⁵⁶-1, far beyond JavaScript’s Number range).
 *
 * @throws Error if `c` is zero.
 */
export function mulDivRoundedDown(
  a: bigint | number,
  b: bigint | number,
  c: bigint | number
): bigint {
  const divisor = BigInt(c);
  if (divisor === 0n) throw new Error("division by zero");

  return (BigInt(a) * BigInt(b)) / divisor; // integer division → floors by default
}

export function decodeCheckTokenCreditAndDebit(hexString: string) {
  // normalise & length-check
  if (!hexString.startsWith("0x")) hexString = "0x" + hexString;
  if (ethersUtils.utils.arrayify(hexString).length !== 64) {
    throw new Error("data must be exactly 64 bytes (two int64s padded to 32 bytes each)");
  }

  // ➊  ABI-decode to three BigNumbers (32-byte signed words)
  const result = 
    ethersUtils.utils.defaultAbiCoder.decode(["int64", "int64"], hexString);

  if(result.length != 2) {
    throw new Error('result must be length = 2')
  }
  // ➋  Convert the ethers BigNumbers (unsigned) into real signed 64-bit values
  // console.log()
  return {
    sumOut: result[0],
    sumIn:  result[1]
  };
}

export function encodePath(path: string[], fees: FeeAmount[], payer: string): string {
  if (path.length != fees.length + 1) {
    throw new Error('path/fee lengths do not match')
  }

  let encoded = '0x'
  for (let i = 0; i < fees.length; i++) {
    // 20 byte encoding of the address
    encoded += path[i].slice(2)
    // 3 byte encoding of the fee
    encoded += fees[i].toString(16).padStart(2 * FEE_SIZE, '0')
  }
  // encode the final token
  encoded += path[path.length - 1].slice(2)

  // do the payer
  encoded += payer.slice(2)
  return encoded.toLowerCase()
}
const pad20 = (addr: string) => ethersUtils.utils.hexZeroPad(addr, 20);
