import { createServer, type AddressInfo, type Socket as TCPSocket, type Server as TCPServer } from 'net'
import { createSocket, type RemoteInfo, type Socket as UDPSocket } from 'dgram'

import { once, EventEmitter } from 'events'
import type { PeerStoreType, PublicNodesEmitter } from '../types'
import Debug from 'debug'
import { red } from 'chalk'
import { networkInterfaces } from 'os'
import type { NetworkInterfaceInfo } from 'os'

import { CODE_P2P, CODE_IP4, CODE_IP6, CODE_TCP, CODE_UDP } from '../constants'
import type { Connection } from 'libp2p-interfaces/connection'
import type { MultiaddrConnection, Upgrader, Listener as InterfaceListener } from 'libp2p-interfaces/transport'

import type PeerId from 'peer-id'
import { Multiaddr } from 'multiaddr'

import { handleStunRequest, getExternalIp } from './stun'
import { getAddrs } from './addrs'
import { isAnyAddress } from '@hoprnet/hopr-utils'
import { TCPConnection } from './tcp'

const log = Debug('hopr-connect:listener')
const error = Debug('hopr-connect:listener:error')
const verbose = Debug('hopr-connect:verbose:listener')

// @TODO to be adjusted
export const MAX_RELAYS_PER_NODE = 5
const SOCKET_CLOSE_TIMEOUT = 500

/**
 * Attempts to close the given maConn. If a failure occurs, it will be logged.
 * @private
 * @param maConn
 */
async function attemptClose(maConn: MultiaddrConnection) {
  if (maConn == null) {
    return
  }

  try {
    await maConn.close()
  } catch (err) {
    error('an error occurred while closing the connection', err)
  }
}

type NodeEntry = PeerStoreType & {
  latency: number
}

function latencyCompare(a: NodeEntry, b: NodeEntry) {
  return a.latency - b.latency
}

function isUsableRelay(ma: Multiaddr) {
  const tuples = ma.tuples()

  return tuples[0].length >= 2 && tuples[0][0] == CODE_IP4 && [CODE_UDP, CODE_TCP].includes(tuples[1][0])
}

enum State {
  UNINITIALIZED,
  LISTENING,
  CLOSING,
  CLOSED
}

type Address = { port: number; address: string }

class Listener extends EventEmitter implements InterfaceListener {
  private __connections: MultiaddrConnection[]
  protected tcpSocket: TCPServer
  private udpSocket: UDPSocket

  private state: State

  private listeningAddr?: Multiaddr

  protected publicNodes: NodeEntry[]
  protected uncheckedNodes: PeerStoreType[]

  protected addrs: {
    interface: Multiaddr[]
    external: Multiaddr[]
    relays: Multiaddr[]
  }

  /**
   * @param handler called on incoming connection
   * @param upgrader inform libp2p about incoming connections
   * @param publicNodes emits on new and dead entry nodes
   * @param initialNodes array of entry nodes that is know at startup
   * @param peerId own id
   * @param _interface interface to listen on, e.g. eth0
   * @param __runningLocally [testing] treat local addresses as public addresses
   */
  constructor(
    private handler: ((conn: Connection) => void) | undefined,
    private upgrader: Pick<Upgrader, 'upgradeInbound' | 'upgradeOutbound'>,
    publicNodes: PublicNodesEmitter | undefined,
    private initialNodes: PeerStoreType[] = [],
    private peerId: PeerId,
    private _interface: string | undefined,
    private __runningLocally: boolean
  ) {
    super()

    this.publicNodes = []
    this.uncheckedNodes = initialNodes

    this.__connections = []
    this.upgrader = upgrader

    this.tcpSocket = createServer()
    this.udpSocket = createSocket({
      // @TODO
      // `udp6` does not seem to work in Node 12.x
      // can receive IPv6 packet and IPv4 after reconnecting the socket
      type: 'udp4',
      // set to true to reuse port that is bound
      // to TCP socket
      reuseAddr: true
    })

    this.state = State.UNINITIALIZED

    this.udpSocket.once('close', () => {
      if (![State.CLOSING, State.CLOSED].includes(this.state)) {
        console.trace(`UDP socket was closed earlier than expected. Please report this!`)
      }
    })

    this.tcpSocket.once('close', () => {
      if (![State.CLOSING, State.CLOSED].includes(this.state)) {
        console.trace(`TCP socket was closed earlier than expected. Please report this!`)
      }
    })

    // Forward socket errors
    this.tcpSocket.on('error', (err) => this.emit('error', err))
    this.udpSocket.on('error', (err) => this.emit('error', err))

    this.tcpSocket.on('connection', async (socket: TCPSocket) => {
      try {
        await this.onTCPConnection(socket)
      } catch (err) {
        error(`network error`, err)
      }
    })
    this.udpSocket.on('message', (msg: Buffer, rinfo: RemoteInfo) => handleStunRequest(this.udpSocket, msg, rinfo))

    this.addrs = {
      interface: [],
      external: [],
      relays: []
    }

    publicNodes?.on('addPublicNode', this.onNewRelay.bind(this))

    publicNodes?.on('removePublicNode', this.onRemoveRelay.bind(this))
  }

  /**
   * Called once there is a new relay opportunity known
   * @param ma Multiaddr of node that is added as a relay opportunity
   */
  protected onNewRelay(peer: PeerStoreType) {
    if (peer.id.equals(this.peerId)) {
      return
    }

    if (peer.multiaddrs == undefined || peer.multiaddrs.length == 0) {
      log(`Received entry node ${peer.id.toB58String()} without any multiaddr`)
      return
    }

    for (const uncheckedNode of this.uncheckedNodes) {
      if (uncheckedNode.id.equals(peer.id)) {
        log(`Received duplicate entry node ${peer.id.toB58String()}`)
        // TODO add difference to previous multiaddrs
        return
      }
    }

    this.uncheckedNodes.push({
      id: peer.id,
      multiaddrs: peer.multiaddrs.filter(isUsableRelay)
    })
  }

  /**
   * Called once a node is considered to be offline
   * @param ma Multiaddr of node that is considered to be offline now
   */
  protected onRemoveRelay(peer: PeerId) {
    for (const [index, publicNode] of this.publicNodes.entries()) {
      if (publicNode.id.equals(peer)) {
        // Remove node without changing order
        this.publicNodes.splice(index, 1)
      }
    }

    let inUse = false
    const peerB58String = peer.toB58String()
    for (const [index, relayAddr] of this.addrs.relays.entries()) {
      // remove second part of relay address to get relay peerId
      if (relayAddr.decapsulateCode(CODE_P2P).getPeerId() === peerB58String) {
        // Remove node without changing order
        this.addrs.relays.splice(index, 1)
        inUse = true
      }
    }

    log(
      `relay ${peer.toB58String()} ${red(`removed`)}. Current addrs:\n\t${this.addrs.relays
        .map((addr: Multiaddr) => addr.toString())
        .join(`\n\t`)}`
    )

    // Only rebuild list of relay nodes if we were using the
    // offline node
    if (inUse) {
      // Rebuild later
      setImmediate(this.updatePublicNodes.bind(this))
    }
  }

  /**
   * Updates the list of exposed entry nodes.
   * Called at startup and once an entry node is considered offline.
   */
  protected async updatePublicNodes(): Promise<void> {
    const knownNodes = new Set<string>(this.publicNodes.map((entry: NodeEntry) => entry.id.toB58String()))
    const nodesToCheck: PeerStoreType[] = []

    for (const uncheckedNode of this.uncheckedNodes) {
      if (uncheckedNode.id.equals(this.peerId)) {
        continue
      }

      const usableAddresses: Multiaddr[] = uncheckedNode.multiaddrs.filter(isUsableRelay)

      if (knownNodes.has(uncheckedNode.id.toB58String())) {
        const index = this.publicNodes.findIndex((entry) => entry.id.equals(uncheckedNode.id))

        if (index < 0) {
          continue
        }

        // Overwrite previous addresses. E.g. a node was restarted
        // and now announces with a different address
        this.publicNodes[index].multiaddrs = usableAddresses

        // Nothing to do. Public nodes are added later
        continue
      }

      // Ignore if entry nodes have more than one address
      nodesToCheck.push({
        id: uncheckedNode.id,
        multiaddrs: [usableAddresses[0]]
      })
    }

    const TIMEOUT = 3e3

    const results = await Promise.allSettled(
      nodesToCheck.concat(this.publicNodes).map(async (entry: PeerStoreType): Promise<NodeEntry> => {
        let latency = await this.connectToRelay(entry.multiaddrs[0], TIMEOUT)

        return {
          ...entry,
          latency
        }
      })
    )

    let values: NodeEntry[] = []
    for (const result of results) {
      if (result.status === 'fulfilled' && result.value.latency >= 0) {
        values.push(result.value)
      }
    }

    // Take all entry nodes that appeared to be online
    this.publicNodes = values.sort(latencyCompare)

    // Reset list of unchecked nodes
    this.uncheckedNodes = []

    const previous = new Set(this.addrs.relays.map((ma) => ma.toString()))

    this.addrs.relays = this.publicNodes
      // select only those entry nodes with smallest latencies
      .slice(0, MAX_RELAYS_PER_NODE)
      .map(
        (entry: NodeEntry) =>
          new Multiaddr(`/p2p/${entry.id.toB58String()}/p2p-circuit/p2p/${this.peerId.toB58String()}`)
      )

    let isDifferent = false
    for (const current of this.addrs.relays) {
      if (!previous.has(current.toString())) {
        isDifferent = true
        break
      }
    }

    if (isDifferent) {
      log(`Current relay addresses:`)
      for (const ma of this.addrs.relays) {
        log(`\t${ma.toString()}`)
      }

      if (this.state == State.LISTENING) {
        // updates libp2p's peer record and lets libp2p push
        // the updated peer record to all connected peers
        this.emit('listening')
      }
    }
  }

  /**
   * Attaches the listener to TCP and UDP sockets
   * @param ma address to listen to
   */
  async listen(ma: Multiaddr): Promise<void> {
    if (this.state == State.CLOSED) {
      throw Error(`Cannot listen after 'close()' has been called`)
    }

    const protos = ma.tuples()
    let family: NetworkInterfaceInfo['family']

    switch (protos[0][0]) {
      case CODE_IP4:
        family = 'IPv4'
        break
      case CODE_IP6:
        family = 'IPv6'
        break
      default:
        throw Error(`Can only bind to IPv4 or IPv6 addresses`)
    }

    if (protos.length > 1 && protos[1][0] != CODE_TCP) {
      throw Error(`Can only bind to TCP sockets`)
    }

    if (this.peerId.toB58String() !== ma.getPeerId()) {
      let tmpListeningAddr = ma.decapsulateCode(CODE_P2P)

      if (!tmpListeningAddr.isThinWaistAddress()) {
        throw Error(`Unable to bind socket to <${tmpListeningAddr.toString()}>`)
      }

      // Replace wrong PeerId in given listeningAddr with own PeerId
      log(`replacing peerId in ${ma.toString()} by our peerId which is ${this.peerId.toB58String()}`)
      this.listeningAddr = tmpListeningAddr.encapsulate(`/p2p/${this.peerId.toB58String()}`)
    } else {
      this.listeningAddr = ma
    }

    const options = this.listeningAddr.toOptions()

    options.host = this.getAddressForInterface(options.host, family)

    if (options.port == 0 || options.port == null) {
      // First bind to any TCP port and then
      // bind the UDP socket and bind to same port
      await this.listenTCP().then((tcpPort) => this.listenUDP(tcpPort))
    } else {
      await Promise.all([
        // prettier-ignore
        this.listenTCP(options),
        this.listenUDP(options.port)
      ])
    }

    const address = this.tcpSocket.address() as AddressInfo

    this.addrs.interface.push(
      ...getAddrs(address.port, this.peerId.toB58String(), {
        useIPv4: true,
        includePrivateIPv4: true,
        includeLocalhostIPv4: true
      })
    )

    // Prevent from sending a STUN request to self
    let usableStunServers = this.getUsableStunServers(address.port, address.address)
    await this.determinePublicIpAddress(usableStunServers)
    await this.updatePublicNodes()

    this.state = State.LISTENING
    this.emit('listening')
  }

  /**
   * Closes the listener and closes underlying TCP and UDP sockets.
   * @dev ignores prematurely closed TCP sockets
   */
  async close(): Promise<void> {
    this.state = State.CLOSING

    await Promise.all([this.closeUDP(), this.closeTCP()])

    this.state = State.CLOSED
    this.emit('close')
  }

  /**
   * Used to determine which addresses to announce in the network.
   * @dev Should be called after `listen()` has returned
   * @dev List gets updated while waiting for `listen()`
   * @returns list of addresses under which the node is available
   */
  getAddrs(): Multiaddr[] {
    return (
      [...this.addrs.external, ...this.addrs.relays, ...this.addrs.interface]
        // Filter empty entries
        .filter((addr) => addr)
    )
  }

  /**
   * Get amount of currently open connections
   * @dev used for testing
   * @returns amount of currently open connections
   */
  getConnections(): number {
    return this.__connections.length
  }

  /**
   * Tracks connections to close them once necessary.
   * @param maConn connection to track
   */
  private trackConn(maConn: MultiaddrConnection) {
    this.__connections.push(maConn)
    verbose(`currently tracking ${this.__connections.length} connections ++`)

    const untrackConn = () => {
      verbose(`currently tracking ${this.__connections.length} connections --`)
      let index = this.__connections.findIndex((c: MultiaddrConnection) => c === maConn)

      if (index < 0) {
        // connection not found
        verbose(`DEBUG: Connection not found.`, maConn)
        return
      }

      if ([index + 1, 1].includes(this.__connections.length)) {
        this.__connections.pop()
      } else {
        this.__connections[index] = this.__connections.pop() as MultiaddrConnection
      }
    }

    ;(maConn.conn as EventEmitter).once('close', untrackConn)
  }

  /**
   * Called on incoming TCP Connections. Initiates libp2p handshakes.
   * @param socket socket of incoming connection
   */
  private async onTCPConnection(socket: TCPSocket) {
    // Avoid uncaught errors caused by unstable connections
    socket.on('error', (err) => error('socket error', err))

    let maConn: MultiaddrConnection | undefined
    let conn: Connection

    try {
      maConn = TCPConnection.fromSocket(socket, this.peerId) as any
    } catch (err) {
      if (err instanceof Error) {
        error(`inbound connection failed. ${err.message}`)
      } else {
        console.trace()
        error(`inbound connection failed with non-error instance`, err)
      }
    }

    if (maConn == undefined) {
      socket.destroy()
      return
    }

    log('new inbound connection %s', maConn.remoteAddr)

    try {
      conn = await this.upgrader.upgradeInbound(maConn)
    } catch (err: any) {
      if (err.code === 'ERR_ENCRYPTION_FAILED') {
        error(`inbound connection failed because encryption failed. Maybe connected to the wrong node?`)
      } else {
        error('inbound connection failed', err)
      }

      if (maConn != undefined) {
        return attemptClose(maConn)
      }

      return
    }

    log('inbound connection %s upgraded', maConn.remoteAddr)

    this.trackConn(maConn)

    this.handler?.(conn)

    this.emit('connection', conn)
  }

  /**
   * Binds the process to a UDP socket
   * @param port binding port
   */
  private async listenUDP(port: number): Promise<number> {
    await this.bindToPort('UDP', { port })

    return this.udpSocket.address().port
  }

  /**
   * Binds the process to a TCP socket
   * @param opts host and port to bind to
   */
  private async listenTCP(opts?: { host?: string; port: number }): Promise<number> {
    await this.bindToPort('TCP', opts)

    return (this.tcpSocket.address() as AddressInfo).port
  }

  private bindToPort(protocol: 'UDP' | 'TCP', opts?: { host?: string; port: number }) {
    return new Promise<void>((resolve, reject) => {
      let socket: TCPServer | UDPSocket
      let done = false

      switch (protocol) {
        case 'TCP':
          socket = this.tcpSocket
          break
        case 'UDP':
          socket = this.udpSocket
          break
        default:
          throw Error(`Can only handle 'TCP' and 'UDP' but got ${protocol}`)
      }

      const errListener = (err: any) => {
        socket.removeListener('listening', successListener)
        if (!done) {
          done = true
          reject(err)
        }
      }

      const successListener = () => {
        socket.removeListener('error', errListener)
        if (!done) {
          done = true
          resolve()
        }
      }

      socket.once('error', errListener)
      socket.once('listening', successListener)

      try {
        switch (protocol) {
          case 'TCP':
            ;(socket as TCPServer).listen(opts)
            break
          case 'UDP':
            ;(socket as UDPSocket).bind(opts?.port)
            break
        }
      } catch (err) {
        socket.removeListener('error', errListener)
        socket.removeListener('listening', successListener)

        error(`Could not bind to ${protocol} socket.`)
        if (err instanceof Error) {
          error(err.message)
        } else {
          console.trace()
          error(`Non-error instance was thrown.`, err)
        }

        if (!done) {
          done = true
          reject(err)
        }
      }
    })
  }

  /**
   * Closes the TCP socket and tries to close all pending
   * connections.
   * @returns Promise that resolves once TCP socket is closed
   */
  private async closeTCP() {
    if (!this.tcpSocket.listening) {
      return
    }

    await Promise.all(this.__connections.map(attemptClose))

    const promise = once(this.tcpSocket, 'close')

    this.tcpSocket.close()

    // Node.js bug workaround: ocassionally on macOS close is not emitted and callback is not called
    return Promise.race([
      promise,
      new Promise<void>((resolve) =>
        setTimeout(() => {
          resolve()
        }, SOCKET_CLOSE_TIMEOUT)
      )
    ])
  }

  /**
   * Closes the UDP socket
   * @returns Promise that resolves once UDP socket is closed
   */
  private closeUDP() {
    const promise = once(this.udpSocket, 'close')

    this.udpSocket.close()

    return promise
  }

  /**
   * Tries to determine a node's public IP address by
   * using STUN servers
   * @param port the port on which we are listening
   * @param host [optional] the host on which we are listening
   * @returns Promise that resolves once STUN request came back or STUN timeout was reched
   */
  private async determinePublicIpAddress(usableStunServers: Multiaddr[]): Promise<void> {
    let externalAddress: Address | undefined
    try {
      externalAddress = await getExternalIp(usableStunServers, this.udpSocket, this.__runningLocally)
    } catch (err) {
      error(`Determining public IP failed`)

      if (err instanceof Error) {
        error(err.message)
      } else {
        console.trace()
        error(`Non-error instance was thrown`, err)
      }

      return
    }

    if (externalAddress == undefined) {
      log(`STUN requests led to multiple ambiguous results, hence node seems to be behind a bidirectional NAT.`)
      return
    }

    const externalMultiaddr = Multiaddr.fromNodeAddress(
      {
        address: externalAddress.address,
        port: externalAddress.port,
        family: 4
      },
      'tcp'
    ).encapsulate(`/p2p/${this.peerId}`)

    this.addrs.interface = this.addrs.interface.filter((ma: Multiaddr) => !externalMultiaddr.equals(ma))

    this.addrs.external.push(externalMultiaddr)
  }

  private getPotentialStunServers(): Multiaddr[] {
    const result = []
    for (const node of this.initialNodes.concat(this.publicNodes)) {
      if (!node.id.equals(this.peerId)) {
        result.push(...node.multiaddrs)
      }
    }

    return result
  }

  /**
   * Returns a list of STUN servers that we can use to determine
   * our own public IP address
   * @param port the port on which we are listening
   * @param host [optional] the host on which we are listening
   * @returns a list of STUN servers, excluding ourself
   */
  private getUsableStunServers(port: number, host?: string): Multiaddr[] {
    const potentialStunServers = this.getPotentialStunServers()

    if (host == undefined) {
      return potentialStunServers
    }

    const usableStunServers: Multiaddr[] = []

    for (const potentialStunServer of potentialStunServers) {
      let cOpts: { host: string; port: number }
      try {
        cOpts = potentialStunServer.toOptions()
      } catch (err) {
        continue
      }

      if (cOpts.host === host && cOpts.port === port) {
        continue
      }

      usableStunServers.push(potentialStunServer)
    }

    return usableStunServers
  }

  private getAddressForInterface(host: string, family: NetworkInterfaceInfo['family']): string {
    if (this._interface == undefined) {
      return host
    }

    const osInterfaces = networkInterfaces()

    if (osInterfaces == undefined) {
      throw Error(`Machine seems to have no networkInterfaces.`)
    }

    if (osInterfaces[this._interface] == undefined) {
      throw Error(`Machine does not have requested interface ${this._interface}`)
    }

    const usableInterfaces = osInterfaces[this._interface]?.filter(
      (iface: NetworkInterfaceInfo) => iface.family == family && !iface.internal
    )

    if (usableInterfaces == undefined || usableInterfaces.length == 0) {
      throw Error(`Desired interface <${this._interface}> does not exist or does not have any external addresses.`)
    }

    const index = usableInterfaces.findIndex((iface) => host == iface.address)

    if (!isAnyAddress(host, family) && index < 0) {
      throw Error(
        `Could not bind to interface ${
          this._interface
        } on address ${host} because it was configured with a different addresses: ${usableInterfaces
          .map((iface) => iface.address)
          .join(`, `)}`
      )
    }

    // @TODO figure what to do if there is more than one address
    return usableInterfaces[0].address
  }

  private async connectToRelay(relay: Multiaddr, timeout: number): Promise<number> {
    let conn: Connection | undefined
    let maConn: TCPConnection | undefined

    const start = Date.now()

    try {
      maConn = await TCPConnection.create(relay, this.peerId, { timeout })
    } catch (err) {
      if (maConn != undefined) {
        await attemptClose(maConn as any)
      }
    }

    if (maConn == undefined) {
      return -1
    }

    try {
      conn = await this.upgrader.upgradeOutbound(maConn as any)
    } catch (err: any) {
      if (err.code === 'ERR_ENCRYPTION_FAILED') {
        error(
          `outbound connection to potential relay node failed because encryption failed. Maybe connected to the wrong node?`
        )
      } else {
        error('outbound connection to potential relay node failed.', err)
      }
      if (conn != undefined) {
        try {
          await conn.close()
        } catch (err) {
          error(err)
        }
      }
    }

    if (conn == undefined) {
      return -1
    }

    this.trackConn(maConn as any)

    this.handler?.(conn)

    this.emit('connection', conn)

    return Date.now() - start
  }
}

export { Listener }
