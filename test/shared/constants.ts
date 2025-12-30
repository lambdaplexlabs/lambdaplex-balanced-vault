import { BigNumber } from 'ethers'

export const MaxUint128 = BigNumber.from(2).pow(128).sub(1)
export const MaxInt64 = BigNumber.from(2).pow(63).sub(1)