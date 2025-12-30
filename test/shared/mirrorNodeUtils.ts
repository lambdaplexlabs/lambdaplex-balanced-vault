import axios from 'axios';
import hardhat from 'hardhat'
import { wait } from '././HederaUtils';

// local hashscan: http://127.0.0.1:8090/mainnet/dashboard
function getMirrorNodeURL(environment: String) {
    switch (environment) {
        case 'mainnet':
            return 'https://mainnet-public.mirrornode.hedera.com/';
        case 'previewnet':
            return 'https://previewnet.mirrornode.hedera.com/';
        case 'local':
            return 'http://localhost:5551/'
        case 'testnet':
        default:
            return 'https://testnet.mirrornode.hedera.com/'
    }
}

export async function getErrorForRevert(txId: string, network: string = hardhat.network.name) {
    // console.log('tx id = ' + txId)
    let url = getMirrorNodeURL(network)
    let endpoint = `${url}api/v1/contracts/results/${txId}`
    let data = await axios.get(endpoint)

    if(!data || !data.data ) {
        return Promise.reject('getErrorForRevert: no data returned from get request')
    } else if(data.status != 200) {
        return Promise.reject(`getErrorForRevert: data.status was not 200, status = ${data.status} with message\n${data.statusText}`)
        
    }

    return data.data.error_message
}

export async function getReturnValueFromCall(txId: string, network: string = hardhat.network.name) {
    wait(3000)
    let url = getMirrorNodeURL(network)
    let endpoint = `${url}api/v1/contracts/results/${txId}`
    let data = await axios.get(endpoint)

    if(!data || !data.data) {
        return Promise.reject('getErrorForRevert: no data returned from get request')
    } else if(data.status != 200) {
        return Promise.reject(`getReturnValueFromCall: data.status was not 200, status = ${data.status} with message\n${data.statusText}`)
    }

    return data.data.call_result
}

// export async function txToRevert(transaction: any, reason: string): Promise<boolean>{
// 	let tx;
// 	let txId;
	
// 	try {
// 		tx = await transaction
// 	} catch (error: any) {
// 		txId = error.transaction.transactionId;
		
// 		// Mirror node needs at least 3 seconds to catch up
// 		wait(3000)

// 		let errorMsg = await getErrorForRevert(txId)
// 		const val = selectorToNameMap.get(errorMsg)
// 		if((val && val === reason) || errorMsg.includes(reason)) {
// 			return true;
// 		} else {
// 			throw Error('Tx reverted with '+errorMsg+' instead of '+reason)
// 		}
// 	}
	
// 	return false;
// }

export async function txToRevertWithMessage(transaction: any): Promise<string>{
	let tx;
	let txId;
	
	try {
		tx = await transaction
	} catch (error: any) {
		txId = error.transaction.transactionId;
		
		// Mirror node needs at least 4 seconds to catch up
		wait(4000)

		let errorMsg = await getErrorForRevert(txId)
        return errorMsg;
	}
	
	return '';
}

export async function getTokenBalanceForId(id: string, tokenId: string, network: string = hardhat.network.name) {
    let url = getMirrorNodeURL(network)
    let endpoint = `${url}api/v1/accounts/${id}/tokens?token.id=${tokenId}`
    let data = await axios.get(endpoint)
      if(!data || !data.data) {
        return -1
    }

    try {
        return data.data.tokens[0].balance
    } catch {
        return '0'
    }
}

export async function getHbarBalanceForId(accountId: string, network: string = hardhat.network.name) {
    let url = getMirrorNodeURL(network)
    let endpoint = `${url}api/v1/balances/?account.id=${accountId}`
    let data = await axios.get(endpoint)
      if(!data || !data.data) {
        return -1
    }
    return data.data.balances[0].balance
}