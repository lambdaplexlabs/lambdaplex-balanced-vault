import { AccountAllowanceApproveTransaction, AccountId, AccountUpdateTransaction, Client, ContractCreateTransaction, ContractId, ContractLogInfo, ContractUpdateTransaction, Hbar, HbarUnit, TokenAssociateTransaction, TokenCreateTransaction, TokenId, TokenSupplyType, TransactionId, TransactionRecordQuery, TransferTransaction } from '@hashgraph/sdk'
import { Contract, ethers } from 'ethers'
import { BigNumber as BigNumberJs } from 'bignumber.js'
import {
  BigNumber
} from 'ethers'
import Long from "long";

export const BASE_TEN = 10

export function expandToDecimalsJs(n: number, decimals: number = 8): BigNumberJs {
  return new BigNumberJs(n).multipliedBy(new BigNumberJs(BASE_TEN).pow(decimals))
}

export function wait(ms: number) {
    var start = new Date().getTime();
    var end = start;
    while (end < start + ms) {
        end = new Date().getTime();
    }
  }
  
  export function getTxIdForGetRecords(transactionId: string) {
    let txid = transactionId.split('-')
    return txid[0]+'@'+txid[1]+'.'+txid[2]
  }
  
  export async function getTxRecords(txId: TransactionId, clientToUse: Client) {
    let txRecordQuery = await new TransactionRecordQuery()
        .setTransactionId(txId)
        .setIncludeChildren(true)
        .setValidateReceiptStatus(false)
        .execute(clientToUse)
  
    return txRecordQuery
  }
  
  export async function getTransactionRecordFromTxId(txId: string, client: Client) {
  
    let temp = txId.replace('-', '@')
    let sanitized = temp.replace('-', '.')
    let id = TransactionId.fromString(sanitized)
    let query = await new TransactionRecordQuery()
      .setTransactionId(id)
      .execute(client)
  
    return query;
  }

  export async function deployToken(name: string, symbol: string, client: Client) {
    let initSupply = expandToDecimalsJs(10, 12)
    let maxSupply = expandToDecimalsJs(10, 14)
  
    if (!client.operatorAccountId) throw new Error('client null')
    //Create the transaction and freeze for manual signing
    const transaction = new TokenCreateTransaction()
      .setTokenName(name)
      .setTokenSymbol(symbol)
      .setDecimals(8)
      .setSupplyType(TokenSupplyType.Finite)
      .setTreasuryAccountId(client.operatorAccountId)
      .setInitialSupply(Long.fromString(initSupply.toString()))
      .setMaxSupply(Long.fromString(maxSupply.toString()))
      .setMaxTransactionFee(new Hbar(30)) //Change the default max transaction fee
      .freezeWith(client);
  
    //Sign the transaction with the client operator private key and submit to a Hedera network
    const txResponse = await transaction.execute(client);
  
    //Get the receipt of the transaction
    const receipt = await txResponse.getReceipt(client);
  
    //Get the token ID from the receipt
    const tokenId = receipt.tokenId;
  
    if (!tokenId) throw new Error('token didnt deploy')
  
    return tokenId;
  }

  export async function associateTokens(tokens: TokenId[], account: AccountId, client: Client) {
    const transaction = new TokenAssociateTransaction()
        .setAccountId(account)
        .setTokenIds(tokens)
        .freezeWith(client);
  
    const txResponse = await transaction.execute(client);
    let receipt = await txResponse.getReceipt(client)
    return receipt.status
  }

  export async function approveToken(token: TokenId, owner: string, spender: string, amount: string, clientToUse: Client) {
    const approve = await new AccountAllowanceApproveTransaction()
        .approveTokenAllowance(token, owner, spender, Long.fromString(amount))
        .execute(clientToUse);
  
    return await approve.getReceipt(clientToUse);
  }

  export async function transferTinybars(sender: AccountId, receiver: string, amount: string, client: Client) {

    let tx = new TransferTransaction()
        .addHbarTransfer(receiver, new Hbar(amount, HbarUnit.Tinybar))
        .addHbarTransfer(sender, new Hbar(-amount, HbarUnit.Tinybar))
        .freezeWith(client)

    return await tx.execute(client)
}
  
export async function transferTokens(tokenId: TokenId, amount: number, to: AccountId | ContractId, from: AccountId, client: Client) {

    const transaction = new TransferTransaction()
        .addTokenTransfer(tokenId, AccountId.fromString(to.toString()), amount)
        .addTokenTransfer(tokenId, AccountId.fromString(from.toString()), -amount)
        .freezeWith(client);
  
    const txResponse = await transaction.execute(client);
    const receipt = txResponse.getReceipt(client);
  
    return receipt;
  }