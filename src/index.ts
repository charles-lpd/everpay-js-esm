import { TransactionResponse } from '@ethersproject/abstract-provider'
import {
  ChainType, Config, EverpayInfo, EverpayBase, BalanceParams, BalancesParams, DepositParams,
  TransferOrWithdrawResult, TransferParams, WithdrawParams, EverpayTxWithoutSig, EverpayAction,
  BalanceItem, TxsParams, TxsByAccountParams, TxsResult, EverpayTransaction
} from './global'
import { getChainId, getEverpayTxDataField, signMessageAsync, transferAsync } from './lib/sign'
import { getEverpayBalance, getEverpayBalances, getEverpayInfo, getEverpayTransaction, getEverpayTransactions, postTx } from './api'
import { everpayTxVersion, getEverpayHost } from './config'
import { getTimestamp, getTokenBySymbol, toBN, getAccountChainType } from './utils/util'
import { GetEverpayBalanceParams, GetEverpayBalancesParams } from './api/interface'
import { utils } from 'ethers'
import { checkParams } from './utils/check'
import { ArTransferResult } from './lib/interface'

class Everpay extends EverpayBase {
  constructor (config?: Config) {
    super()
    this._config = {
      ...config,
      account: config?.account ?? ''
    }
    this._apiHost = getEverpayHost(config?.debug)
    this._cachedTimestamp = 0
  }

  private readonly _apiHost: string
  private readonly _config: Config
  private _cachedInfo?: EverpayInfo
  private _cachedTimestamp: number

  getAccountChainType = getAccountChainType

  async info (): Promise<EverpayInfo> {
    // cache info 3 mins
    if (this._cachedInfo === undefined || (getTimestamp() - 3 * 60 > this._cachedTimestamp)) {
      this._cachedInfo = await getEverpayInfo(this._apiHost)
      this._cachedTimestamp = getTimestamp()
    }
    return this._cachedInfo
  }

  async balance (params: BalanceParams): Promise<number> {
    await this.info()
    const { symbol, account } = params
    const acc = account ?? this._config.account as string
    const token = getTokenBySymbol(symbol, this._cachedInfo?.tokenList)
    checkParams({ account: acc, symbol, token })
    const mergedParams: GetEverpayBalanceParams = {
      id: token?.id as string,
      chainType: token?.chainType as ChainType,
      symbol: params.symbol,
      account: acc
    }
    const everpayBalance = await getEverpayBalance(this._apiHost, mergedParams)
    return toBN(utils.formatUnits(everpayBalance.balance.amount, everpayBalance.balance.decimals)).toNumber()
  }

  async balances (params?: BalancesParams): Promise<BalanceItem[]> {
    await this.info()
    params = (params ?? {}) as BalanceParams
    const { account } = params
    const acc = account ?? this._config.account as string
    checkParams({ account: acc })
    const mergedParams: GetEverpayBalancesParams = {
      account: acc
    }
    const everpayBalances = await getEverpayBalances(this._apiHost, mergedParams)
    const balances = everpayBalances.balances.map(item => {
      const tag = item.tag
      const [chainType, symbol, address] = tag.split('-')
      return {
        chainType,
        symbol: symbol.toUpperCase(),
        address,
        balance: toBN(utils.formatUnits(item.amount, item.decimals)).toString()
      }
    })
    return balances
  }

  async txs (params: TxsParams): Promise<TxsResult> {
    const { page } = params
    return await getEverpayTransactions(this._apiHost, { page })
  }

  async txsByAccount (params: TxsByAccountParams): Promise<TxsResult> {
    const { page, account } = params
    checkParams({ account: account ?? this._config.account })
    return await getEverpayTransactions(this._apiHost, {
      page,
      account: account ?? this._config.account
    })
  }

  async txByHash (everHash: string): Promise<EverpayTransaction> {
    checkParams({ everHash })
    return await getEverpayTransaction(this._apiHost, everHash)
  }

  async deposit (params: DepositParams): Promise<TransactionResponse | ArTransferResult> {
    await this.info()
    const { amount, symbol } = params
    const token = getTokenBySymbol(symbol, this._cachedInfo?.tokenList)
    const value = utils.parseUnits(toBN(amount).toString(), token?.decimals)
    const from = this._config.account
    checkParams({ account: from, symbol, token, amount })

    return await transferAsync(this._config, this._cachedInfo as EverpayInfo, {
      symbol,
      tokenID: token?.id ?? '',
      from: from ?? '',
      value
    })
  }

  async sendEverpayTx (action: EverpayAction, params: TransferParams): Promise<TransferOrWithdrawResult> {
    const { chainType, symbol, amount } = params
    const to = params?.to
    const token = getTokenBySymbol(symbol, this._cachedInfo?.tokenList)
    const from = this._config.account as string
    const accountChainType = getAccountChainType(from)
    const everpayTxWithoutSig: EverpayTxWithoutSig = {
      tokenSymbol: symbol,
      action,
      from,
      to,
      amount: utils.parseUnits(toBN(amount).toString(), token?.decimals).toString(),
      fee: action === EverpayAction.withdraw ? (token?.burnFee ?? '0') : '0',
      feeRecipient: this._cachedInfo?.feeRecipient.toLowerCase() ?? '',
      nonce: Date.now().toString(),
      tokenID: token?.id.toLowerCase() as string,
      chainType: chainType,
      chainID: getChainId(this._cachedInfo as EverpayInfo, chainType),
      data: await getEverpayTxDataField(this._config, accountChainType),
      version: everpayTxVersion
    }
    console.log('owner', everpayTxWithoutSig.data)
    console.log('everpayTxWithoutSig', JSON.stringify(everpayTxWithoutSig))
    checkParams({ account: from, symbol, token, amount, to })

    const { everHash, sig } = await signMessageAsync(this._config, everpayTxWithoutSig)
    console.log('sig', sig)

    const everpayTx = {
      ...everpayTxWithoutSig,
      sig
    }
    const postEverpayTxResult = await postTx(this._apiHost, everpayTx)
    return {
      ...postEverpayTxResult,
      everpayTx,
      everHash
    }
  }

  async transfer (params: TransferParams): Promise<TransferOrWithdrawResult> {
    await this.info()
    return await this.sendEverpayTx(EverpayAction.transfer, params)
  }

  async withdraw (params: WithdrawParams): Promise<TransferOrWithdrawResult> {
    await this.info()
    const token = getTokenBySymbol(params.symbol, this._cachedInfo?.tokenList)
    checkParams({ token })
    const amount = toBN(params.amount).minus(toBN(utils.formatUnits(token?.burnFee ?? '', token?.decimals))).toString()
    const to = params.to ?? this._config.account as string
    return await this.sendEverpayTx(EverpayAction.withdraw, {
      ...params,
      amount,
      to
    })
  }
}

export default Everpay
