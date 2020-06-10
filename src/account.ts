import HoprEthereum from '.'

import { AccountId, Balance, Hash, NativeBalance, TicketEpoch } from './types'
import { pubKeyToAccountId } from './utils'
import { stringToU8a } from '@hoprnet/hopr-utils'

class Account {
  private _nonce?: number
  private _nonceIterator: AsyncIterator<number>

  /**
   * The accounts keys:
   */
  public keys: {
    onChain: {
      privKey: Uint8Array
      pubKey: Uint8Array
    }
    offChain: {
      privKey: Uint8Array
      pubKey: Uint8Array
    }
  }
  constructor(public coreConnector: HoprEthereum, privKey: Uint8Array, pubKey: Uint8Array) {
    this.keys = {
      onChain: {
        privKey,
        pubKey,
      },
      offChain: {
        privKey,
        pubKey,
      },
    }

    this._nonceIterator = async function* () {
      this._nonce = await this.coreConnector.web3.eth.getTransactionCount((await this.address).toHex())

      while (true) {
        yield this._nonce++
      }
    }.call(this)
  }

  get nonce(): Promise<number> {
    return this._nonceIterator.next().then((res) => res.value)
  }

  get balance(): Promise<Balance> {
    return new Promise<Balance>(async (resolve, reject) => {
      try {
        resolve(new Balance(await this.coreConnector.hoprToken.methods.balanceOf((await this.address).toHex()).call()))
      } catch (err) {
        reject(err)
      }
    })
  }

  get nativeBalance(): Promise<NativeBalance> {
    return new Promise(async (resolve, reject) => {
      try {
        resolve(new NativeBalance(await this.coreConnector.web3.eth.getBalance((await this.address).toHex())))
      } catch (err) {
        reject(err)
      }
    })
  }

  get ticketEpoch(): Promise<TicketEpoch> {
    return new Promise(async (resolve, reject) => {
      try {
        resolve(
          new TicketEpoch(
            (await this.coreConnector.hoprChannels.methods.accounts((await this.address).toHex()).call()).counter
          )
        )
      } catch (err) {
        reject(err)
      }
    })
  }

  /**
   * Returns the current value of the onChainSecret
   */
  get onChainSecret(): Promise<Hash> {
    return new Promise<Hash>(async (resolve, reject) => {
      try {
        resolve(
          new Hash(
            stringToU8a(
              (await this.coreConnector.hoprChannels.methods.accounts((await this.address).toHex()).call()).hashedSecret
            )
          )
        )
      } catch (err) {
        reject(err)
      }
    })
  }

  get address(): Promise<AccountId> {
    return pubKeyToAccountId(this.keys.onChain.pubKey)
  }
}

export default Account
