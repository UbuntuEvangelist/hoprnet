import type { HardhatRuntimeEnvironment } from 'hardhat/types'
import type { DeployFunction } from 'hardhat-deploy/types'
import { HoprToken__factory } from '../src/types'
import { utils, constants } from 'ethers'

const PROTOCOL_CONFIG = require('../../core/protocol-config.json')

const main: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { ethers, deployments, network, getNamedAccounts, environment } = hre

  const environmentConfig = PROTOCOL_CONFIG.environments[environment]
  const mintedTokenReceiver = environmentConfig['minted_token_receiver_address']

  const deployer = await getNamedAccounts().then((o) => ethers.getSigner(o.deployer))

  const result = await deployments.deploy('HoprToken', {
    from: deployer.address,
    log: true
  })

  if (network.tags.testing || network.tags.development) {
    const hoprToken = new HoprToken__factory(deployer).attach(result.address)
    const MINTER_ROLE = await hoprToken.MINTER_ROLE()
    const isDeployerMinter = await hoprToken.hasRole(MINTER_ROLE, deployer.address)

    // on "testing" networks, we cannot wait 10 blocks as there is no auto-mine
    // on "development" networks, we must wait 10 blocks since hardhat is not aware of the txs
    if (!isDeployerMinter) {
      console.log('Granting MINTER role to', deployer.address)
      const grantRoleTx = hoprToken.grantRole(MINTER_ROLE, deployer.address)
      if (network.tags.development) {
        await (await grantRoleTx).wait(10)
      } else {
        await grantRoleTx
      }

      if (mintedTokenReceiver) {
        console.log('Minting tokens to', mintedTokenReceiver)
        const mintTx = hoprToken.mint(
          mintedTokenReceiver,
          utils.parseEther('130000000'),
          constants.HashZero,
          constants.HashZero
        )

        if (network.tags.development) {
          await (await mintTx).wait(10)
        } else {
          await mintTx
        }
      }
    }
  }
}

// this smart contract should not be redeployed on a production network
main.skip = async (env) => !!env.network.tags.production
main.dependencies = ['preDeploy']

export default main
