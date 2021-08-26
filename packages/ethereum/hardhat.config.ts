import type { HardhatRuntimeEnvironment, HardhatConfig, SolcUserConfig } from 'hardhat/types'
// load env variables
require('dotenv').config()
// load hardhat plugins
import '@nomiclabs/hardhat-ethers'
import '@nomiclabs/hardhat-solhint'
import '@nomiclabs/hardhat-waffle'
import 'hardhat-deploy'
import 'hardhat-gas-reporter'
import 'solidity-coverage'
import '@typechain/hardhat'
import { utils } from 'ethers'

// rest
import { HardhatUserConfig, task, types, extendEnvironment, extendConfig } from 'hardhat/config'
import { ethers } from 'ethers'
export type DeploymentTypes = 'testing' | 'development' | 'staging' | 'production'
export type NetworkTag = DeploymentTypes | 'etherscan'

const { DEPLOYER_WALLET_PRIVATE_KEY, ETHERSCAN_KEY, ENVIRONMENT_ID = 'default' } = process.env
import { expandVars } from '@hoprnet/hopr-utils'

extendConfig((config: HardhatConfig) => {
  config.etherscan.apiKey = ETHERSCAN_KEY
})

extendEnvironment((hre: HardhatRuntimeEnvironment) => {
  hre.environment = ENVIRONMENT_ID
})

const PROTOCOL_CONFIG = require('../hoprd/protocol-config.json')

function networkToHardhatNetwork(input: any): any {
  let res: any = {
    chainId: input.chain_id,
    gasPrice: 'auto',
    gasMultiplier: input.gas_multiplier,
    live: input.live,
    tags: input.tags
  }

  if (input.gas) {
    const parsedGas = input.gas.split(' ')
    res.gas = Number(utils.parseUnits(parsedGas[0], parsedGas[1]))
  }

  if (input.live) {
    try {
      res.url = expandVars(input.default_provider, process.env)
    } catch (_) {
      res.url = 'invalid_url'
    }
    res.accounts = DEPLOYER_WALLET_PRIVATE_KEY ? [DEPLOYER_WALLET_PRIVATE_KEY] : []
    res.companionNetworks = {}
    res.mining = undefined
  } else {
    res.saveDeployments = true
    res.mining = {
      auto: true, // every transaction will trigger a new block (without this deployments fail)
      interval: [1000, 3000] // mine new block every 1 - 3s
    }
  }
  return res
}

const networks = {}

for (const network of PROTOCOL_CONFIG.networks) {
  const hardhatNetwork = networkToHardhatNetwork(network)
  networks[network.id] = hardhatNetwork
}

const hardhatConfig: HardhatUserConfig = {
  defaultNetwork: 'hardhat',
  networks: {
    // hardhat-deploy cannot run deployments if the network is not hardhat
    // we use an ENV variable (which is specified in our NPM script)
    // to let hardhat know we want to run hardhat in 'development' mode
    // this essentially enables mining, see below
    hardhat: {
      live: false,
      tags: [DEVELOPMENT ? 'development' : 'testing'] as NetworkTag[],
      saveDeployments: true,
      mining: DEVELOPMENT
        ? {
            auto: true, // every transaction will trigger a new block (without this deployments fail)
            interval: [1000, 3000] // mine new block every 1 - 3s
          }
        : undefined
    },
    goerli: {
      ...networks.goerli,
      live: true,
      tags: ['staging'] as NetworkTag[],
      gasMultiplier: GAS_MULTIPLIER,
      url: `https://goerli.infura.io/v3/${INFURA_KEY}`,
      accounts: DEPLOYER_WALLET_PRIVATE_KEY ? [DEPLOYER_WALLET_PRIVATE_KEY] : []
    },
    xdai: {
      ...networks.xdai,
      live: true,
      tags: ['production'] as NetworkTag[],
      gasMultiplier: GAS_MULTIPLIER,
      url: `https://still-patient-forest.xdai.quiknode.pro/${QUIKNODE_KEY}/`,
      accounts: DEPLOYER_WALLET_PRIVATE_KEY ? [DEPLOYER_WALLET_PRIVATE_KEY] : []
    },
    mumbai: {
      ...networks.mumbai,
      live: false,
      tags: ['development'] as NetworkTag[],
      gasMultiplier: GAS_MULTIPLIER,
      url: `https://polygon-mumbai.infura.io/v3/${INFURA_KEY}`,
      accounts: DEPLOYER_WALLET_PRIVATE_KEY ? [DEPLOYER_WALLET_PRIVATE_KEY] : []
    },
    polygon: {
      ...networks.polygon,
      live: true,
      tags: ['testing'] as NetworkTag[],
      url: `https://polygon-mainnet.infura.io/v3/${INFURA_KEY}`,
      accounts: DEPLOYER_WALLET_PRIVATE_KEY ? [DEPLOYER_WALLET_PRIVATE_KEY] : []
    }
  },
  namedAccounts: {
    deployer: 0
  },
  solidity: {
    compilers: ['0.8.3', '0.6.6', '0.4.24'].map<SolcUserConfig>((version) => ({
      version,
      settings: {
        optimizer: {
          enabled: true,
          runs: 200
        }
      }
    }))
  },
  paths: {
    sources: './contracts',
    tests: './test',
    cache: './hardhat/cache',
    artifacts: './hardhat/artifacts',
    deployments: `./deployments/${ENVIRONMENT_ID}`
  },
  typechain: {
    outDir: './types',
    target: 'ethers-v5'
  },
  gasReporter: {
    currency: 'USD',
    excludeContracts: ['mocks', 'utils/console.sol']
  }
}

task('faucet', 'Faucets a local development HOPR node account with ETH and HOPR tokens', async (...args: any[]) => {
  return (await import('./tasks/faucet')).default(args[0], args[1], args[2])
})
  .addParam<string>('address', 'HoprToken address', undefined, types.string)
  .addOptionalParam<string>('amount', 'Amount of HOPR to fund', ethers.utils.parseEther('1').toString(), types.string)
  .addOptionalParam<boolean>(
    'ishopraddress',
    'Whether the address passed is a HOPR address or not',
    false,
    types.boolean
  )

task('accounts', 'View unlocked accounts', async (...args: any[]) => {
  return (await import('./tasks/getAccounts')).default(args[0], args[1], args[2])
})

export default hardhatConfig
