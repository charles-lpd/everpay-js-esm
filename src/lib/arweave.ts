import Arweave from 'arweave'
import isString from 'lodash/isString'
import { ArJWK, ArweaveTransaction, ChainType } from '../types'
import { getTokenAddrByChainType, isArweaveL2PSTTokenSymbol } from '../utils/util'
import { TransferAsyncParams } from './interface'
import hashPersonalMessage from './hashPersonalMessage'
import { sendRequest } from '../api'

const options = {
  host: 'arweave.net', // Hostname or IP address for a Arweave host
  port: 443, // Port
  protocol: 'https', // Network protocol http or https
  timeout: 20000, // Network request timeouts in milliseconds
  logging: false // Enable network request logging
}

// TODO: to fix arConnect return result and interface
enum ERRORS {
  PLEASE_INSTALL_ARCONNECT = 'PLEASE_INSTALL_ARCONNECT',
  ACCESS_ADDRESS_PERMISSION_NEEDED = 'ACCESS_ADDRESS_PERMISSION_NEEDED',
  ACCESS_PUBLIC_KEY_PERMISSION_NEEDED = 'ACCESS_PUBLIC_KEY_PERMISSION_NEEDED',
  SIGNATURE_PERMISSION_NEEDED = 'NEED_SIGNATURE_PERMISSION',
  SIGN_TRANSACTION_PERMISSION_NEEDED = 'SIGN_TRANSACTION_PERMISSION_NEEDED',
  SIGNATURE_FAILED = 'SIGNATURE_FAILED',
  TRANSACTION_POST_ERROR = 'TRANSACTION_POST_ERROR',
  ACCESS_PUBLIC_KEY_FAILED = 'ACCESS_PUBLIC_KEY_FAILED'
}

export const checkArPermissions = async (permissions: string[] | string): Promise<void> => {
  let existingPermissions: string[] = []
  permissions = isString(permissions) ? [permissions] : permissions

  try {
    existingPermissions = await window.arweaveWallet.getPermissions()
  } catch {
    throw new Error(ERRORS.PLEASE_INSTALL_ARCONNECT)
  }

  if (permissions.length === 0) {
    return
  }

  if (permissions.some(permission => {
    return !existingPermissions.includes(permission)
  })) {
    await window.arweaveWallet.connect(permissions as never[])
  }
}

const signMessageAsync = async (arJWK: ArJWK, address: string, everHash: string): Promise<string> => {
  const arweave = Arweave.init(options)
  const everHashBuffer: Buffer = Buffer.from(everHash.slice(2), 'hex')
  let arOwner = ''
  let signatureB64url = ''
  // web
  if (arJWK === 'use_wallet') {
    try {
      await checkArPermissions('ACCESS_PUBLIC_KEY')
    } catch {
      throw new Error(ERRORS.ACCESS_PUBLIC_KEY_PERMISSION_NEEDED)
    }
    try {
      // TODO: wait arweave-js update arconnect.d.ts
      arOwner = await (window.arweaveWallet as any).getActivePublicKey()
    } catch {
      throw new Error(ERRORS.ACCESS_PUBLIC_KEY_FAILED)
    }

    try {
      await checkArPermissions('SIGNATURE')
    } catch {
      throw new Error(ERRORS.SIGNATURE_PERMISSION_NEEDED)
    }

    const algorithm = {
      name: 'RSA-PSS',
      saltLength: 32
    }

    try {
      // TODO: wait arweave-js update arconnect.d.ts
      const signature = await (window.arweaveWallet as any).signature(
        everHashBuffer,
        algorithm
      )
      const buf = new Uint8Array(Object.values(signature))
      signatureB64url = Arweave.utils.bufferTob64Url(buf)
    } catch {
      throw new Error(ERRORS.SIGNATURE_FAILED)
    }

  // node
  } else {
    const buf = await arweave.crypto.sign(arJWK, everHashBuffer, {
      saltLength: 32
    })
    arOwner = arJWK.n
    signatureB64url = Arweave.utils.bufferTob64Url(buf)
  }

  return `${signatureB64url},${arOwner}`
}

const verifySigAsync = async (address: string, messageData: string, sig: string): Promise<boolean> => {
  const options = {
    host: 'arweave.net',
    port: 443,
    protocol: 'https',
    timeout: 20000,
    logging: false
  }
  const [signature, owner] = sig.split(',')
  const arweave = Arweave.init(options)
  const ownerAddr = await arweave.wallets.ownerToAddress(owner)
  const personalMsgHashBuffer = hashPersonalMessage(Buffer.from(messageData))
  const isCorrectOwner = ownerAddr === address
  if (!isCorrectOwner) {
    return false
  }
  const verified = await arweave.crypto.verify(owner, personalMsgHashBuffer, arweave.utils.b64UrlToBuffer(signature))
  return verified
}

const transferAsync = async (arJWK: ArJWK, chainType: ChainType, {
  symbol,
  token,
  from,
  to,
  value
}: TransferAsyncParams): Promise<ArweaveTransaction> => {
  const arweave = Arweave.init(options)
  let transactionTransfer: any

  if (symbol.toUpperCase() === 'AR') {
    transactionTransfer = await arweave.createTransaction({
      target: to,
      quantity: value.toString()
    }, arJWK)

  // PST Token
  } else {
    const tokenID = getTokenAddrByChainType(token, ChainType.arweave)
    transactionTransfer = await arweave.createTransaction({
      data: (Math.random() * 10000).toFixed(),
      last_tx: isArweaveL2PSTTokenSymbol(token.symbol) ? 'p7vc1iSP6bvH_fCeUFa9LqoV5qiyW-jdEKouAT0XMoSwrNraB9mgpi29Q10waEpO' : undefined,
      reward: isArweaveL2PSTTokenSymbol(token.symbol) ? '0' : undefined
    }, arJWK)
    transactionTransfer.addTag('App-Name', 'SmartWeaveAction')
    transactionTransfer.addTag('App-Version', '0.3.0')
    transactionTransfer.addTag('Contract', tokenID)
    transactionTransfer.addTag('Input', JSON.stringify({
      function: 'transfer',
      qty: value.toNumber(),
      target: to
    }))
  }

  if (arJWK === 'use_wallet') {
    try {
      const existingPermissions = await window.arweaveWallet.getPermissions() as string[]
      if (!existingPermissions.includes('SIGN_TRANSACTION')) {
        await window.arweaveWallet.connect(['SIGN_TRANSACTION'])
      }
    } catch (_a) {
      // Permission is already granted
    }
    const signedTransaction = await window.arweaveWallet.sign(transactionTransfer)
    // TODO: Temp fix arConnect modify reward
    transactionTransfer.reward = signedTransaction.reward
    transactionTransfer.setSignature({
      id: signedTransaction.id,
      owner: signedTransaction.owner,
      tags: signedTransaction.tags,
      signature: signedTransaction.signature
    })
  } else {
    // 直接给原来 transaction 赋值了 signature 值
    await arweave.transactions.sign(transactionTransfer, arJWK)
  }
  let responseTransfer = null as any
  if (isArweaveL2PSTTokenSymbol(token.symbol)) {
    await sendRequest({
      url: 'https://gateway.warp.cc/gateway/sequencer/register',
      data: transactionTransfer,
      headers: {
        // 'Accept-Encoding': 'gzip, deflate, br',
        'Content-Type': 'application/json',
        Accept: 'application/json'
      },
      method: 'POST'
    })
    responseTransfer = {
      status: 200,
      data: {}
    }
    // responseTransfer = await fetch('https://gateway.warp.cc/gateway/sequencer/register', {
    //   method: 'POST',
    //   body: JSON.stringify(transactionTransfer),
    //   headers: {
    //     'Accept-Encoding': 'gzip, deflate, br',
    //     'Content-Type': 'application/json',
    //     Accept: 'application/json'
    //   }
    // })
  } else {
    responseTransfer = await arweave.transactions.post(transactionTransfer)
  }

  if (responseTransfer.status === 200) {
    // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions
    if (responseTransfer.data.error) {
      throw new Error(responseTransfer.data.error)
    }
    return transactionTransfer
  }
  throw new Error(ERRORS.TRANSACTION_POST_ERROR)
}

export default {
  signMessageAsync,
  verifySigAsync,
  transferAsync
}
