// This version uses libp2p only and sends the data directly to peers
// - Works great for low amount of peers and requires less abstractions
// - However, large images not possible to send
// - Peers can not help to "seed" each others image, making it less efficient
const WS = require('libp2p-websockets')
const WebRTCStar = require('libp2p-webrtc-star')
const Multiplex = require('libp2p-multiplex')
const SECIO = require('libp2p-secio')
const libp2p = require('libp2p')

const PeerInfo = require('peer-info')
const PeerId = require('peer-id')
const PeerBook = require('peer-book')
const Multiaddr = require('multiaddr')
const toBuffer = require('typedarray-to-buffer')
const pull = require('pull-stream')
const pushable = require('pull-pushable')

class Node extends libp2p {
  constructor (peerInfo, peerBook, options) {
    options = options || {}
    const wstar = new WebRTCStar()

    const modules = {
      transport: [new WS(), wstar],
      connection: {
        muxer: [Multiplex],
        crypto: [SECIO]
      },
      discovery: [wstar.discovery]
    }

    super(modules, peerInfo, peerBook, options)
  }
}

// CONSTANTS
// size of webcam video feed
const SIZES = {
  width: 128,
  height: 128
}
// Delay for sending
const SEND_EACH_MS = 100
// Protocol for our application
const PROTOCOL = '/resort/0.1.0'
// Which signal server to use, overwrite default while in dev
// const SIGNAL_SERVER = '/ip4/127.0.0.1/ws/p2p-webrtc-star/ipfs/:peer-id'
const SIGNAL_SERVER = '/dns4/ws-star.discovery.libp2p.io/tcp/443/wss/p2p-websocket-star/ipfs/:peer-id'

// Create and start a libp2p Peer to use
const startOwnPeer = (callback) => {
  PeerId.create((err, peerId) => {
    if (err) callback(err)
    const peerInfo = new PeerInfo(peerId)
    const peerBook = new PeerBook()
    const mh1 = Multiaddr(SIGNAL_SERVER.replace(':peer-id', peerId.toB58String()))
    peerInfo.multiaddrs.add(mh1)
    const node = new Node(peerInfo, peerBook, {
        webRTCStar: true
    })
    node.start((err) => {
      if (err) callback(err)
      callback(null, node)
    })
  })
}
// Mutable global of all open connections, containing pushable pull-stream with
// Peer ID as key
const _OPEN_CONNECTIONS = {}

const listenAndConnectToPeers = (node) => {
  node.on('peer:discovery', (peer) => {
    const id = peer.id._idB58String
    if (_OPEN_CONNECTIONS[id] === undefined) {
      node.dial(peer, PROTOCOL, (err, conn) => {
        // Ignore errors, as not everyone supports our protocol
        if (err) return
        // Create a pushable pull-stream that we can write to
        const p = pushable()
        pull(p, conn)
        // Assign the pull-stream to our global
        _OPEN_CONNECTIONS[id] = p
        // Create a canvas for this peer
        createCanvas(id)
      })
    } else {
      console.log('Already connected to peer', id)
    }
  })
  // When connection to a peer closes, remove the canvas
  node.swarm.on('peer-mux-closed', (peer) => {
    removeCanvas(peer.id._idB58String)
  })
  // TODO maybe should listen for peer errors as well
  // TODO should setup a check and see when we last received data, if more than
  // X seconds, kill feed
}

// Mutable global with references to all canvases we have created
const _CANVASES = {}

const createCanvas = (id) => {
  if (id === undefined) throw new Error('ID needs to be defined')
  if (_CANVASES[id] !== undefined) throw new Error('Already had a canvas for ID')

  const canvas = document.createElement('canvas')
  canvas.setAttribute('width', SIZES.width)
  canvas.setAttribute('height', SIZES.height)
  const ctx = canvas.getContext('2d')
  _CANVASES[id] = ctx

  // Write some text on the canvas while we get the first frame
  ctx.font='15px Verdana'
  ctx.fillText('Loading video', 15, 70)

  document.getElementById('feeds').append(canvas)
}
const getCanvas = (id) => {
  if (id === undefined) throw new Error('ID needs to be defined')

  return _CANVASES[id]
}
const removeCanvas = (id) => {
  if (id === undefined) throw new Error('ID needs to be defined')

  _CANVASES[id].canvas.remove()
}

window.addEventListener('load', () => {
  // Our feed from the camera
  const video = document.getElementById('video');

  startOwnPeer((err, node) => {
    if (err) throw err
    const myID = node.peerInfo.id._idB58String
    console.log('Your ID: ' + myID)
    createCanvas(myID)

    listenAndConnectToPeers(node)
    setInterval(() => {
      const mhs = node.peerBook.getAllArray()
      console.log('Connected to ' + mhs.length + ' other peers')
    }, 2000)

    // Handle incoming connections from peers
    // TODO get peer id together with first data somehow?
    // Right now we cannot get a live feed until getPeerInfo returns
    node.handle(PROTOCOL, (protocol, conn) => {
      console.log('Incoming connection')
      let peerID
      conn.getPeerInfo((err, info) => {
        if (err) throw err
        peerID = info.id._idB58String
      })
      pull(
        conn,
        pull.through((data) => {
          // getPeerInfo might not have given us the Peer ID yet...
          if (peerID !== undefined) {
            const canvas = getCanvas(peerID)
            // We might not created the canvas yet...
            if (canvas !== undefined) {
              const dataToRender = new ImageData(new Uint8ClampedArray(data), SIZES.width, SIZES.height)
              canvas.putImageData(dataToRender, 0, 0);
            }
          }
        }),
        pull.collect((err) => {
          if (err) throw err
        })
      )
    })
    // Check if webcam is supported
    // TODO provide fallback if it isn't
    if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
      // Request webcam permissions
      navigator.mediaDevices.getUserMedia({ video: true }).then(function (stream) {
        // Write webcam data to video element
        video.srcObject = stream
        video.play()
      })
    }

    function drawAndSend() {
      // If we don't have our own canvas yet, is because camera has yet to init
      const myCanvas = getCanvas(myID)
      if (myCanvas !== undefined) {

        // Write video feed into canvas
        myCanvas.drawImage(video, 0, 0, SIZES.width, SIZES.height)

        // Get image data from canvas
        const data = myCanvas.getImageData(0, 0, SIZES.width, SIZES.height)

        // Convert data into buffer and send to each open connection
        const bufferToWrite = toBuffer(data.data)

        // For each open connection we have
        Object.keys(_OPEN_CONNECTIONS).forEach((id) => {
          const stream = _OPEN_CONNECTIONS[id]
          // Write image data to the pull-stream
          stream.push(bufferToWrite)
        })
      }
      // Repeat this as fast as possible but with delay of 100ms
      setTimeout(drawAndSend, SEND_EACH_MS)
    }
    // Start recursive function
    drawAndSend()
  })
})
